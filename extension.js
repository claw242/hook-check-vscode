'use strict';
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { extractHooks } = require('./src/hooks');
const { checkCommand, severityOf } = require('./src/resolve');
const { runHook, samplePayload, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES } = require('./src/runner');

const SETTINGS_FILE = /[\\/]\.claude[\\/]settings(\.local)?\.json$/;
const SEVERITY = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

let confirmRun = defaultConfirm;

function isClaudeSettings(document) {
  return document.uri.scheme === 'file' && SETTINGS_FILE.test(document.uri.fsPath);
}

// Dossier du projet : le dossier ouvert qui contient le fichier, sinon le parent de .claude.
function projectDirFor(document) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) return folder.uri.fsPath;
  const claudeDir = path.dirname(document.uri.fsPath);
  const parent = path.dirname(claudeDir);
  return parent === os.homedir() ? undefined : parent;
}

function contextFor(document) {
  return {
    projectDir: projectDirFor(document),
    homeDir: os.homedir(),
    pathEnv: process.env.PATH || '',
    platform: process.platform,
  };
}

function analyse(document) {
  const { hooks } = extractHooks(document.getText());
  const ctx = contextFor(document);
  return hooks.map((hook) => ({ hook, check: checkCommand(hook.command, ctx), ctx }));
}

function refreshDiagnostics(document, collection) {
  if (!isClaudeSettings(document)) return;
  const diagnostics = [];
  for (const { hook, check } of analyse(document)) {
    const level = severityOf(check.status);
    if (!level) continue;
    const range = new vscode.Range(document.positionAt(hook.start), document.positionAt(hook.end));
    const diagnostic = new vscode.Diagnostic(range, `${hook.event}: ${check.message}`, SEVERITY[level]);
    diagnostic.source = 'Hook Check';
    diagnostics.push(diagnostic);
  }
  collection.set(document.uri, diagnostics);
}

class HookLensProvider {
  provideCodeLenses(document) {
    if (!isClaudeSettings(document)) return [];
    return analyse(document).map(({ hook }) => {
      const range = new vscode.Range(document.positionAt(hook.start), document.positionAt(hook.start));
      return new vscode.CodeLens(range, {
        title: 'Test this hook',
        command: 'hookCheck.testHook',
        arguments: [document.uri, hook.start],
      });
    });
  }
}

async function defaultConfirm(details) {
  const choice = await vscode.window.showWarningMessage(
    'Run this hook command on your machine?',
    { modal: true, detail: details },
    'Run',
  );
  return choice === 'Run';
}

async function testHook(output, uri, offset) {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showErrorMessage(
      'Hook Check does not run hooks in Restricted Mode. Trust this workspace first, then try again.',
    );
    return undefined;
  }
  const document = await vscode.workspace.openTextDocument(uri);
  if (!isClaudeSettings(document)) return undefined;
  const entry = analyse(document).find(({ hook }) => offset >= hook.start && offset <= hook.end);
  if (!entry) {
    vscode.window.showInformationMessage('Hook Check: put the cursor inside a hook "command" string.');
    return undefined;
  }
  const { hook, ctx } = entry;
  const cwd = ctx.projectDir || path.dirname(path.dirname(document.uri.fsPath));
  const stdin = samplePayload(hook.event, cwd);
  const details = [
    `Command:\n${hook.command}`,
    `Folder: ${cwd}`,
    `Input (stdin): a sample ${hook.event} JSON`,
    `Limits: ${DEFAULT_TIMEOUT_MS / 1000} s, ${DEFAULT_MAX_BYTES / 1024} KB of output.`,
  ].join('\n\n');
  if (!(await confirmRun(details))) return undefined;

  output.show(true);
  output.appendLine(`> ${hook.event}: ${hook.command}`);
  const result = await runHook({
    command: hook.command, cwd, stdin, env: { CLAUDE_PROJECT_DIR: cwd },
  });
  if (result.stdout) output.appendLine(result.stdout.trimEnd());
  if (result.stderr) output.appendLine(`[stderr] ${result.stderr.trimEnd()}`);
  if (result.truncated) output.appendLine('[output truncated]');
  const verdict = result.timedOut ? 'timed out after 10 s' : `exit code ${result.exitCode}`;
  const note = result.exitCode === 2 ? ' (exit code 2 blocks the action)' : '';
  output.appendLine(`= ${verdict}${note} in ${result.durationMs} ms\n`);
  return result;
}

function activate(context) {
  const collection = vscode.languages.createDiagnosticCollection('hook-check');
  const output = vscode.window.createOutputChannel('Hook Check');
  const refresh = (document) => refreshDiagnostics(document, collection);

  context.subscriptions.push(
    collection,
    output,
    vscode.workspace.onDidOpenTextDocument(refresh),
    vscode.workspace.onDidChangeTextDocument((e) => refresh(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => collection.delete(d.uri)),
    vscode.languages.registerCodeLensProvider([{ language: 'json' }, { language: 'jsonc' }], new HookLensProvider()),
    vscode.commands.registerCommand('hookCheck.testHook', (uri, offset) => testHook(output, uri, offset)),
    vscode.commands.registerCommand('hookCheck.testHookAtCursor', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return undefined;
      return testHook(output, editor.document.uri, editor.document.offsetAt(editor.selection.active));
    }),
  );
  vscode.workspace.textDocuments.forEach(refresh);

  // Prise reservee aux essais automatiques : elle n'existe PAS dans la version distribuee
  // (mode Production), seulement quand VS Code lance l'extension pour un essai.
  if (context.extensionMode === vscode.ExtensionMode.Test) {
    return { setConfirm(fn) { confirmRun = fn || defaultConfirm; } };
  }
  return undefined;
}

function deactivate() {}

module.exports = { activate, deactivate };
