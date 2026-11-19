# Hook Check

Catch broken hook commands before they silently fail. Hook Check reads your hook settings (`.claude/settings.json` and `.claude/settings.local.json`), tells you when a hook command points to nothing, lets you test one hook on demand, and gives you five guard snippets.

Compatible with the Claude Code hooks settings format. Not affiliated with Anthropic.

Créé avec l'aide de l'IA (created with AI assistance) par Loupe & Lettres.

## What it does

**1. Checks that each hook command exists (it never runs anything).**
Open a `settings.json` file that has a `hooks` section. Hook Check underlines a `command` when:

| What it finds | Level |
| --- | --- |
| The script or program path does not exist | Error |
| The file exists but is not executable (`chmod +x`), or is a folder | Error |
| `python3`, `node`, `bash`... is followed by a script that does not exist | Error |
| A bare program name is not in the PATH that VS Code sees | Warning |
| The command is a pipe, a chain, a redirect or uses variables it does not know | Information: "not checked" |

`$CLAUDE_PROJECT_DIR`, `$HOME` and `~` are understood. The check only looks at files and the PATH: your hook is never started while you type.

**2. Test this hook.** A "Test this hook" lens appears above each command. Click it, read the exact command in the confirmation window, and only if you press **Run** is the command started, with a small sample JSON on stdin for the event (`PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `Stop`). You see the output and the exit code (exit code 2 blocks the action). Safety limits: 10 seconds, 64 KB of output, refused in Restricted Mode (Workspace Trust).

**3. Five guard snippets.** In a JSON file type `hookcheck-` and pick one: block `rm -rf`, block `git push --force`, block tool calls that mention `.env`, block `curl | sh`, block `sudo`. Each one is a ready PreToolUse entry that exits with code 2 to block the call. They are simple pattern guards, a starting point and not a security boundary.

## What it does not do

- It does not tell you whether your hook logic is correct, only that its command can be found. To replay recorded tool calls against a guard hook and see what slips through, see **Hook Proof**: https://loupeetlettres.gumroad.com/l/gvdarr
- It does not validate the JSON structure of the settings file: use a JSON schema for that, Hook Check is complementary.
- It does not know the PATH of your agent session, only the one VS Code sees, so a PATH warning can be a false alarm.
- Tested on macOS with VS Code 1.145 (unit tests plus a run inside the real editor, in Restricted Mode and in a trusted workspace). Windows and Linux are not tested yet.

## Privacy and safety

The extension's own code has no telemetry, makes no network call and needs no account. It only reads the settings files you open. It starts a command only after you click **Run** in a confirmation window, never in Restricted Mode. A hook you test inherits the environment variables of VS Code, like any command typed in a terminal opened from it: read the command in the confirmation window before you press Run.

## Package it yourself

This repository holds the extension source (the unit tests and the editor test are not published here). To build the `.vsix`:

```
npm install
npx vsce package --no-dependencies
```

Then install it with "Extensions: Install from VSIX...".

## Going further

- **Hook Cookbook**: five small, readable hooks for the events most guides skip (`UserPromptSubmit`, `SessionStart`, `PostToolUse`, `Stop`). https://loupeetlettres.gumroad.com/l/dpehuq
- **Hook Proof**: test your guard hooks against recorded tool calls. https://loupeetlettres.gumroad.com/l/gvdarr

## License

MIT. Made by Loupe & Lettres, an AI-assisted publisher: this extension was created with the help of AI.
