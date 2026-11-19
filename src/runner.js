'use strict';
// Lance UN hook, seulement quand l'extension le demande apres un clic explicite.
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 64 * 1024;
const KILL_GRACE_MS = 1000;

const SAMPLE_PAYLOADS = {
  PreToolUse: (cwd) => ({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' }, cwd,
  }),
  PostToolUse: (cwd) => ({
    hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls -la' },
    tool_response: { stdout: 'ok' }, cwd,
  }),
  UserPromptSubmit: (cwd) => ({ hook_event_name: 'UserPromptSubmit', prompt: 'sample prompt', cwd }),
  SessionStart: (cwd) => ({ hook_event_name: 'SessionStart', source: 'startup', cwd }),
  Stop: (cwd) => ({ hook_event_name: 'Stop', stop_hook_active: false, cwd }),
};

function samplePayload(event, cwd) {
  const make = SAMPLE_PAYLOADS[event] || ((dir) => ({ hook_event_name: event, cwd: dir }));
  return JSON.stringify(make(cwd));
}

function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) {
      // Sous Windows le shell a des descendants : taskkill /T les arrete aussi.
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else if (child.pid) {
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch (err) {
    try { child.kill('SIGKILL'); } catch (err2) { /* deja termine */ }
  }
}

// options : { command, cwd, stdin, env, timeoutMs, maxBytes, spawnFn }
function runHook(options) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const spawnFn = options.spawnFn || spawn;
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let used = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const child = spawnFn(options.command, {
      shell: true,
      cwd: options.cwd,
      env: { ...process.env, ...(options.env || {}) },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    function take(chunk, current) {
      const room = maxBytes - used;
      if (room <= 0) {
        truncated = true;
        return current;
      }
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const kept = buf.length > room ? buf.subarray(0, room) : buf;
      if (buf.length > room) truncated = true;
      used += kept.length;
      return current + kept.toString('utf8');
    }

    function finish(exitCode, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode, signal, timedOut, truncated, stdout, stderr, durationMs: Date.now() - started,
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      // Si un descendant garde les flux ouverts, on rend quand meme la main apres 1 s.
      setTimeout(() => finish(null, 'SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout = take(d, stdout); });
    child.stderr.on('data', (d) => { stderr = take(d, stderr); });
    child.on('error', (err) => {
      stderr = take(`Launch error: ${err.message}`, stderr);
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => { /* le hook n'a pas lu son entree : normal */ });
    child.stdin.end(options.stdin || '');
  });
}

module.exports = { runHook, samplePayload, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };
