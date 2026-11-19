'use strict';
// Verifie qu'une commande de hook EXISTE et pourrait s'executer, sans jamais la lancer.
// Ce module n'utilise que fs et path : il ne peut lancer aucun programme.
const nodeFs = require('fs');
const path = require('path');

const STATUS = Object.freeze({
  OK: 'ok',
  MISSING: 'missing',
  NOT_EXECUTABLE: 'not-executable',
  MISSING_IN_PATH: 'missing-in-path',
  INDETERMINATE: 'indeterminate',
});

const INTERPRETERS = new Set([
  'python', 'python3', 'node', 'bash', 'sh', 'zsh', 'deno', 'bun', 'ruby', 'perl',
]);
const BUILTINS_OK = new Set(['echo', 'exit', 'true', 'false', 'cd', 'printf', 'test', '[']);
const BUILTINS_UNKNOWN = new Set([
  'export', 'set', 'read', 'eval', 'exec', 'source', '.', ':', 'if', 'for', 'while', 'case',
  'until', 'function', 'time', '!', '{', '(', 'alias', 'unset', 'trap',
]);
const COMPLEX_CHARS = /[|&;<>`()\n\r\\]/;

function result(status, message, extra) {
  return { status, message, ...(extra || {}) };
}

// Decoupe le debut d'une commande en mots, avec guillemets simples et doubles.
// Renvoie null si la commande est trop complexe pour etre analysee surement.
function splitWords(command, wanted) {
  const words = [];
  let current = '';
  let inWord = false;
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else current += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === ' ' || c === '\t') {
      if (inWord) {
        words.push(current);
        current = '';
        inWord = false;
      }
    } else if (COMPLEX_CHARS.test(c)) {
      return null;
    } else {
      current += c;
      inWord = true;
    }
  }
  if (quote) return null;
  if (inWord) words.push(current);
  return words.slice(0, wanted);
}

// Remplace les variables connues ; renvoie null s'il en reste une inconnue.
function expandWord(word, ctx) {
  let out = word;
  const project = ctx.projectDir;
  const home = ctx.homeDir;
  const replacements = [
    [/\$\{CLAUDE_PROJECT_DIR\}|\$CLAUDE_PROJECT_DIR(?![A-Za-z0-9_])/g, project],
    [/\$\{HOME\}|\$HOME(?![A-Za-z0-9_])/g, home],
  ];
  for (const [pattern, value] of replacements) {
    if (pattern.test(out)) {
      if (!value) return null;
      out = out.replace(pattern, () => value);
    }
  }
  if (out === '~' || out.startsWith('~/')) {
    if (!home) return null;
    out = home + out.slice(1);
  }
  if (out.includes('$') || /[*?[\]{}]/.test(out)) return null;
  return out;
}

function isExecutableFile(fsApi, file, platform) {
  let stat;
  try {
    stat = fsApi.statSync(file);
  } catch (err) {
    return { exists: false, executable: false, isDir: false };
  }
  if (stat.isDirectory()) return { exists: true, executable: false, isDir: true };
  if (platform === 'win32') return { exists: true, executable: true, isDir: false };
  try {
    fsApi.accessSync(file, nodeFs.constants.X_OK);
    return { exists: true, executable: true, isDir: false };
  } catch (err) {
    return { exists: true, executable: false, isDir: false };
  }
}

function findInPath(name, ctx, fsApi) {
  const dirs = (ctx.pathEnv || '').split(ctx.platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = ctx.platform === 'win32' ? ['', '.exe', '.cmd', '.bat', '.com'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      const info = isExecutableFile(fsApi, candidate, ctx.platform);
      if (info.exists && info.executable && !info.isDir) return candidate;
    }
  }
  return null;
}

function checkPathWord(word, ctx, fsApi, label) {
  const absolute = path.isAbsolute(word) ? word : path.resolve(ctx.projectDir || '', word);
  if (!path.isAbsolute(word) && !ctx.projectDir) {
    return result(STATUS.INDETERMINATE, `Cannot resolve the relative path "${word}": no project folder.`);
  }
  const info = isExecutableFile(fsApi, absolute, ctx.platform);
  if (!info.exists) return result(STATUS.MISSING, `${label} not found: ${absolute}`);
  if (info.isDir) return result(STATUS.NOT_EXECUTABLE, `${label} is a folder, not a program: ${absolute}`);
  return result(STATUS.OK, `${label} found: ${absolute}`, { resolved: absolute, executable: info.executable });
}

// ctx : { projectDir, homeDir, pathEnv, platform }
function checkCommand(command, ctx, fsApi) {
  const fsImpl = fsApi || nodeFs;
  const context = { platform: process.platform, ...ctx };
  if (typeof command !== 'string' || command.trim() === '') {
    return result(STATUS.MISSING, 'The hook command is empty.');
  }
  const words = splitWords(command.trim(), 2);
  if (!words || words.length === 0) {
    return result(STATUS.INDETERMINATE, 'Complex shell command (pipe, redirect, chain, quotes): not checked.');
  }
  const first = words[0];
  if (BUILTINS_UNKNOWN.has(first)) {
    return result(STATUS.INDETERMINATE, `Shell keyword or builtin "${first}": not checked.`);
  }
  if (BUILTINS_OK.has(first)) {
    return result(STATUS.OK, `"${first}" is a shell builtin.`);
  }
  const expanded = expandWord(first, context);
  if (expanded === null) {
    return result(STATUS.INDETERMINATE, 'The command uses a variable Hook Check does not know: not checked.');
  }

  let main;
  if (expanded.includes('/') || expanded.includes('\\')) {
    main = checkPathWord(expanded, context, fsImpl, 'Program');
    if (main.status === STATUS.OK && !main.executable) {
      main = result(STATUS.NOT_EXECUTABLE, `Not executable (try chmod +x): ${main.resolved}`);
    }
  } else {
    const found = findInPath(expanded, context, fsImpl);
    main = found
      ? result(STATUS.OK, `Program found: ${found}`, { resolved: found })
      : result(
        STATUS.MISSING_IN_PATH,
        `"${expanded}" was not found in the PATH seen by VS Code (your agent session may use another PATH).`,
      );
  }
  if (main.status !== STATUS.OK) return main;
  return checkInterpreterScript(expanded, words, context, fsImpl, main);
}

function checkInterpreterScript(program, words, context, fsApi, main) {
  const name = path.basename(program).replace(/\.exe$/i, '');
  if (!INTERPRETERS.has(name) || words.length < 2) return main;
  const arg = words[1];
  if (arg.startsWith('-')) return main;
  const expanded = expandWord(arg, context);
  if (expanded === null) return main;
  const script = checkPathWord(expanded, context, fsApi, 'Script');
  return script.status === STATUS.OK ? main : script;
}

// Gravite pour l'affichage : 'error' | 'warning' | 'info' | null (rien a signaler).
function severityOf(status) {
  switch (status) {
    case STATUS.MISSING:
    case STATUS.NOT_EXECUTABLE:
      return 'error';
    case STATUS.MISSING_IN_PATH:
      return 'warning';
    case STATUS.INDETERMINATE:
      return 'info';
    default:
      return null;
  }
}

module.exports = { checkCommand, severityOf, splitWords, STATUS };
