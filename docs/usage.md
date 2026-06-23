# pi-cmux usage

Detailed usage for the cmux integrations bundled with `pi-cmux`.

## Notifications

`cmux-notify` sends `cmux notify` alerts when the main Pi agent finishes a run.

Detected `pi-subagents` subagents skip final-run `Waiting`, `Task Complete`, and `Error` notifications. Configured tool-start notifications are unaffected.

Notification fields:
- title: `Pi` by default
- subtitle: `Waiting`, `Task Complete`, or `Error`
- body: short run summary

Notification bodies are summarized from:
- changed files from `edit` and `write`
- reviewed files from `read`
- searches from `grep` and `find`
- shell activity from `bash`
- final agent errors, with first tool failure as fallback

Set `PI_CMUX_NOTIFY_INCLUDE_RESPONSE=1` to append up to 500 characters of the final assistant response to non-error notifications. This is disabled by default because assistant responses may contain sensitive text.

Noise controls:

```bash
PI_CMUX_NOTIFY_LEVEL=all       # Waiting, Task Complete, Error
PI_CMUX_NOTIFY_LEVEL=medium    # Task Complete, Error
PI_CMUX_NOTIFY_LEVEL=low       # Error only
PI_CMUX_NOTIFY_LEVEL=disabled  # off
```

### Tool notification settings

Tool-start notifications are opt-in. Configure exact Pi tool names under `pi-cmux.notify.tools`:

```json
{
  "pi-cmux": {
    "notify": {
      "tools": {
        "ask_user_question": true
      }
    }
  }
}
```

Supported locations:
- `~/.pi/agent/settings.json` for global tool notifications
- `.pi/settings.json` for project-local tool notifications

When a configured tool starts, `cmux-notify` requests a notification; duplicate identical tool-start notifications may be debounced. `PI_CMUX_NOTIFY_LEVEL=disabled` disables both final-run notifications and configured tool-start notifications.

Subagent final-run suppression does not affect configured tool-start notifications, including tools started while a detected `pi-subagents` subagent is running.

Project settings load after global settings. Set a project entry to `{ "disabled": true }` to remove a global tool notification:

```json
{
  "pi-cmux": {
    "notify": {
      "tools": {
        "ask_user_question": { "disabled": true },
        "read": true
      }
    }
  }
}
```

After changing settings, run `/reload` in Pi.

## Sidebar status/log

`cmux-sidebar` updates the cmux right sidebar while Pi runs. It only activates inside a cmux workspace (`CMUX_WORKSPACE_ID` is present).

It uses:
- `cmux set-status` for a temporary Pi status pill while Pi is running, using tools, waiting, done, or errored
- `cmux set-progress` for coarse run progress and live token counts while Pi is active
- `cmux log` for run starts, changed files, warnings, final summaries, and compact session token counts, with cached input split out
- `cmux trigger-flash` when a run finishes and the surface needs attention

Environment settings:

```bash
PI_CMUX_SIDEBAR=0                    # disable sidebar integration
PI_CMUX_SIDEBAR_FLASH=all            # all | error | disabled
PI_CMUX_SIDEBAR_LOG_TOOLS=1          # log every tool result
PI_CMUX_SIDEBAR_LOG_PROMPT=1         # include truncated prompt in start log
PI_CMUX_SIDEBAR_PROGRESS=0           # disable progress bar updates
PI_CMUX_SIDEBAR_TOKENS=0             # disable compact live session token counts
PI_CMUX_SIDEBAR_COST=1               # include reported model cost with tokens
PI_CMUX_SIDEBAR_FINAL_CLEAR_MS=2500  # clear final status/progress after this delay
PI_CMUX_SIDEBAR_STATUS_KEY=my-key    # override status key
```

## Split tab names

Commands that spawn a split rename the new cmux tab/surface as `<title> · <repo-or-dir>`, using the git repo basename when available and the working-directory basename otherwise. Examples: `Pi · pi-cmux`, `Review · pi-cmux`, `Continue · fix-sidebar`, `npm test · pi-cmux`.

## Split Pi sessions

```text
/cmv [initial prompt]
/cmh [initial prompt]
```

- `/cmv` opens a split to the right.
- `/cmh` opens a split below.
- Both start `pi` in the same working directory.

Examples:

```text
/cmv
/cmh
/cmv Review the auth flow in this repo
```

Legacy aliases:
- `/cmux-v` → `/cmv`
- `/cmux-h` → `/cmh`

## Tool splits and tabs

```text
/cmo <command...>
/cmoh <command...>
/cmt <command...>
```

- `/cmo` opens a split to the right and runs a shell command.
- `/cmoh` opens a split below and runs a shell command.
- `/cmt` opens a new cmux tab and runs a shell command.
- Commands run via `sh -lc` in the current project directory.

Examples:

```text
/cmo hx
/cmo npm test
/cmoh npm run dev
/cmt k9s
/cmo watch -n 1 git status --short
```

Alias:
- `/cmov` → `/cmo`

## Agent-opened terminals

`pi-cmux` registers a `cmux_open_terminal` tool so Pi can open interactive terminal programs when explicitly asked.

Example requests:

```text
open k9s in a new tab
open lazygit in a right split
open npm run dev below
```

The tool supports `tab`, `right`, and `down` placements. It is meant for TUIs, log tails, dev servers, watches, and other terminal views that should remain interactive instead of being captured through the normal shell tool.

## Pluggable tool commands

Register custom split shortcuts in Pi settings under `pi-cmux.commands`.

Supported locations:
- `~/.pi/agent/settings.json` for global commands
- `.pi/settings.json` for project-local commands

Simple form:

```json
{
  "pi-cmux": {
    "commands": {
      "edit": "hx",
      "logs": "tail -f logs/app.log"
    }
  }
}
```

Each configured command opens a right cmux split by default and runs via `sh -lc` in the current project directory.

Examples:

```text
/edit
/logs
```

Use object form for arguments, lower splits, custom tab titles, or descriptions:

```json
{
  "pi-cmux": {
    "commands": {
      "edit": {
        "run": "hx",
        "acceptArgs": true,
        "description": "Open Helix in a cmux split"
      },
      "dev": {
        "run": "npm run dev",
        "direction": "down",
        "title": "dev",
        "description": "Run the dev server below"
      }
    }
  }
}
```

Then use:

```text
/edit src/auth.ts
/dev
```

Supported object keys:
- `run` — shell command to execute
- `acceptArgs` — append slash-command arguments to `run` when set to `true`
- `direction` — `right` or `down`; defaults to `right`
- `title` — optional base tab title before ` · <repo-or-dir>` is appended
- `description` — optional slash-command description
- `disabled` — set to `true` in project settings to remove a global configured command

Configured command names cannot reuse built-in Pi commands such as `/settings`, `/model`, or `/reload`, and they cannot replace `pi-cmux` commands such as `/cmv`, `/cmo`, `/cmz`, `/cmrv`, or `/cmcv`.

If the same command exists in both global and project settings, the project setting wins. After changing settings, run `/reload` in Pi.

No app-specific shortcuts are bundled by default; define the tools you want as configured commands.

## Zoxide directory jumps

```text
/cmz <query>
/cmzh <query>
```

- `/cmz` resolves a zoxide match or direct directory path, then starts Pi in a right split.
- `/cmzh` does the same in a lower split.

Examples:

```text
/cmz mono
/cmzh ~/src/project
```

Legacy aliases:
- `/z` → `/cmz`
- `/zh` → `/cmzh`

## Continuation and worktree handoff

```text
/cmcv [note]
/cmch [note]
/cmcv -c <branch> [--from <ref>] [note]
/cmch -c <branch> [--from <ref>] [note]
```

- `/cmcv` opens a continuation split to the right.
- `/cmch` opens a continuation split below.
- Notes are added as focus context.
- `-c <branch>` creates a new branch worktree and starts Pi there.
- `--from <ref>` chooses the base ref for the new worktree branch.

Examples:

```text
/cmcv
/cmcv focus on tests
/cmcv -c fix/notify-bug
/cmcv -c fix/notify-bug --from main
/cmcv -c fix/notify-bug --from main review the existing changes
/cmch -c feature/review-ui focus on edge cases
```

Same-checkout continuation creates a related handoff session and adds a summary of the current context. If the current Pi session is persisted, the new pane also inherits the current conversation path.

Worktree continuation starts a new session in the target worktree and seeds it with structured handoff context from the source pane.

## Review workflows

Split review commands:

```text
/cmrv
/cmrh
/cmrv [--bugs|--refactor|--tests] <target>
/cmrh [--bugs|--refactor|--tests] <target>
/cmrv --diff [focus]
/cmrh --diff [focus]
```

- `/cmrv` opens a review split to the right.
- `/cmrh` opens a review split below.
- With no arguments, both default to reviewing the current git diff.
- A GitHub PR URL switches the prompt to PR review and asks Pi to inspect it with `gh pr view` and `gh pr diff`.
- If another Pi package provides `code-review`, the generated prompt asks Pi to use it when available.

Examples:

```text
/cmrv
/cmrh
/cmrv src/auth.ts
/cmrv --bugs src/auth.ts
/cmrh --refactor src/auth/
/cmrv --diff
/cmrh --diff focus on token refresh and retries
/cmrv https://github.com/owner/repo/pull/123
```

Legacy aliases:
- `/review-v` → `/cmrv`
- `/review-h` → `/cmrh`

`pi-cmux` does not ship generic in-place `/review`, `/review-diff`, or `code-review` resources. Use those from another package if installed.

## Environment variables

```bash
PI_CMUX_NOTIFY_LEVEL=all|medium|low|disabled
PI_CMUX_NOTIFY_THRESHOLD_MS=15000
PI_CMUX_NOTIFY_DEBOUNCE_MS=3000
PI_CMUX_NOTIFY_TITLE=Pi
PI_CMUX_NOTIFY_INCLUDE_RESPONSE=0|1

PI_CMUX_SIDEBAR=0|1
PI_CMUX_SIDEBAR_FLASH=all|error|disabled
PI_CMUX_SIDEBAR_LOG_TOOLS=0|1
PI_CMUX_SIDEBAR_LOG_PROMPT=0|1
PI_CMUX_SIDEBAR_PROGRESS=0|1
PI_CMUX_SIDEBAR_TOKENS=0|1
PI_CMUX_SIDEBAR_COST=0|1
PI_CMUX_SIDEBAR_FINAL_CLEAR_MS=2500
PI_CMUX_SIDEBAR_PROGRESS_CLEAR_MS=2500  # legacy alias for PI_CMUX_SIDEBAR_FINAL_CLEAR_MS
PI_CMUX_SIDEBAR_STATUS_KEY=<key>
PI_CMUX_SIDEBAR_STATUS_PRIORITY=80
PI_CMUX_SIDEBAR_SOURCE=pi
```

cmux uses the current `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` automatically.
