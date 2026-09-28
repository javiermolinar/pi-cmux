# pi-cmux usage

Detailed usage for the cmux integrations bundled with `pi-cmux`.

## Notifications

`cmux-notify` is disabled by default. Opt in by setting `PI_CMUX_NOTIFY_LEVEL=all` in Pi's environment, then restart Pi or run `/reload`. Leave it disabled when using native cmux hook notifications to avoid duplicate alerts.

When enabled, it sends `cmux notify` alerts once Pi fully settles, after automatic retries, compaction retries, and queued follow-up messages. By default, final-run and configured tool-start notifications only fire from interactive Pi inside a cmux surface (`CMUX_SURFACE_ID` or legacy `CMUX_PANEL_ID`). Headless/embedded runs (SDK, `--print`, JSON, RPC) stay silent even if they inherit cmux variables, as do terminals outside cmux.

Set `PI_CMUX_NOTIFY_FORCE=1` to bypass the mode/surface guard for both notification types. You must still enable `PI_CMUX_NOTIFY_LEVEL`; force does not override `disabled`, final-run severity filtering, or the configured tool list.

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
PI_CMUX_NOTIFY_LEVEL=disabled  # off (default)
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
- `~/.pi/agent/settings.json` for global tool notifications (or `$PI_CODING_AGENT_DIR/settings.json` when configured)
- `.pi/settings.json` under the session's working directory for project-local tool notifications

Also set `PI_CMUX_NOTIFY_LEVEL=all`, `medium`, or `low`; the default `disabled` suppresses both final-run and tool-start notifications. Configured tools notify at any enabled level, independently of the final-run severity filter. Tool-start notifications only run in interactive Pi inside a cmux surface (`CMUX_SURFACE_ID` or legacy `CMUX_PANEL_ID`); headless runs with inherited cmux variables stay silent unless `PI_CMUX_NOTIFY_FORCE=1`. Notification bodies contain the tool name and, when present, the path basename—not the other tool arguments.

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

Malformed settings and invalid entries are ignored with a warning. Settings reload when a session starts or changes; after editing them, run `/reload` in Pi.

## Conversation tab titles

Automatic conversation titles are disabled by default. Enable them with `PI_CMUX_AUTOTITLE=1`, or add this to the agent-directory `settings.json` (normally `~/.pi/agent/settings.json`) or the session project's `.pi/settings.json`:

```json
{
  "pi-cmux": {
    "autotitle": true
  }
}
```

Project settings override global settings. `PI_CODING_AGENT_DIR` selects an alternative agent directory. `PI_CMUX_AUTOTITLE=0` or `1` overrides both settings files; `PI_CMUX_AUTOTITLE_DISABLED=1` always disables the feature. Run `/reload` after changing configuration. Malformed settings are ignored.

After Pi successfully settles, a background request asks for a short topic title from the current session model. Set `PI_CMUX_AUTOTITLE_MODEL` to `provider/model` or an exact available model ID to use another model. An unknown model skips naming. The session's registry handles authentication and custom providers.

The request sends up to four recent user/assistant text messages, each compressed to 300 characters, to that provider. It may incur additional usage charges. No tools, images, or full Pi system prompt are sent, and no child Pi session is created. Naming only runs in TUI mode with `CMUX_SURFACE_ID` or legacy `CMUX_PANEL_ID`, after cmux identifies the calling surface.

Only the tab is renamed, never the workspace. A successful automatic title is stored in session metadata and restored on reload/resume without another model call. `/name` takes priority, including when naming is in flight. `/new`, `/resume`, `/fork`, and tree navigation restore the destination session/branch's naming state instead of carrying over the previous title. Clearing `/name` allows automatic naming again after the next settlement.

Naming does not block lifecycle dispatch or settlement notifications. New turns, session changes, shutdown, and manual names cancel pending work; a 60-second deadline bounds the naming attempt. Late results are discarded. Provider and cmux failures stay silent and allow a later settlement to retry.

## Sidebar status/log

`cmux-sidebar` updates the cmux right sidebar while Pi runs. It only activates inside a cmux workspace (`CMUX_WORKSPACE_ID` is present).

It uses:
- `cmux set-status` for a temporary Pi status pill while Pi is running, using tools, waiting, done, or errored
- `cmux set-progress` for coarse run progress and live token counts while Pi is active
- `cmux log` for run starts, changed files, warnings, final summaries, and compact session token counts, with cached input split out
- `cmux trigger-flash` once a run fully settles and the surface needs attention

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

Split and tab creation uses the surface ID returned by cmux to target command startup and naming, rather than guessing from newly visible panes. Older cmux responses without an ID use bounded discovery; ambiguous results fail without starting a command or renaming a surface.

Commands that spawn a split rename the new cmux tab/surface as `<title> · <repo-or-dir>`, using the git repo basename when available and the working-directory basename otherwise. Examples: `Pi · pi-cmux`, `Review · pi-cmux`, `Continue · fix-sidebar`, `npm test · pi-cmux`.

## New sidebar workspaces

`/cmn <prompt>` and `cmux_start_pi` with workspace placement use `cmux --json workspace create`, verified against cmux **0.64.25 (106)**. The legacy `new-workspace` command ignores `--json` on that version. Older versions have not been verified.

Creation targets the calling Pi terminal's window, not the focused window, and focuses the new workspace by default (`focus: false` keeps it in the background). Pi starts only after the returned workspace and its surface are identified safely. Creation is never automatically retried: an error may leave a workspace open without Pi. Inspect cmux before retrying.

## Split Pi sessions

```text
/cmv [initial prompt]
/cmh [initial prompt]
```

- `/cmv` opens a split to the right.
- `/cmh` opens a split below.
- Both start `pi` in the same working directory.
- Initial prompts are shell-quoted and passed after `--`, so text such as `--help` stays a prompt rather than becoming a Pi option. Inputs beginning with `@` retain Pi's file-input behavior.

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
- Commands run via `/bin/sh -c` in the current project directory, preserving the calling Pi process's `PATH`.
- `/bin/sh -c` is the inner shell. On cmux 0.64.25, `respawn-pane` wraps both Pi and tool launches in `/bin/sh -lc`, so login profiles may run before our command restores `PATH`. Profile side effects are not prevented.
- The caller's shell aliases/functions are not copied. If a command needs a specific shell's initialization, request it explicitly (for example, `/cmo zsh -lic 'my-alias'`).

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

The tool supports `tab`, `right`, and `down` placements. It uses the same `/bin/sh -c` launch and caller `PATH` as the tool commands above. It is meant for TUIs, log tails, dev servers, watches, and other terminal views that should remain interactive instead of being captured through the normal shell tool.

## Browser splits

```text
/cmb http://localhost:3000
/cmb --down https://example.com
/cmb --focus file:///tmp/preview.html
```

- `/cmb [--down] [--focus] <url>` opens a new browser split relative to the calling Pi terminal, not the focused pane.
- Defaults to a right split without taking focus. `--down` opens below; `--focus` focuses the new browser. Flags precede the URL.
- URLs must be absolute HTTP, HTTPS, or local `file://` URLs, without embedded credentials. Percent-encode spaces. Bare hostnames, filesystem paths, remote file hosts, and other URL schemes are rejected.
- The `cmux_open_browser` agent tool accepts `url`, optional `placement` (`right` or `down`), and optional `focus` (default `false`). Use it for explicit requests such as "open http://localhost:3000 in a browser below Pi."
- With a confirmation-capable Pi UI, opening automatically adds an **Annotate** toggle, initially off. It does not enable native Design Mode, steer Pi, or expose page-control tools. Successful opening confirms creation, not page readiness or an HTTP success response. Toggle injection runs separately and retries page readiness for up to 15 seconds; failure leaves the opened browser intact and reports how to retry without creating another split.

Browser opening was tested on cmux **0.64.25**. It requires UUID-bearing caller/creation responses and the `pane.create` RPC; older versions have not been verified. Missing cmux, disabled browser support, incompatible responses, and timeouts produce errors rather than focus-based fallbacks. The extension does not enable browser support globally.

The returned browser UUID is bound in memory to the current Pi session. Quit, `/reload`, and session replacement clear bindings and cancel pending calls, **but leave browser panes open**. Bindings are not restored automatically. In UI-capable sessions, opening starts bounded annotation polling, which revalidates the browser and source terminal before every page operation. Headless opening does not inject or poll for annotations.

Creation is attempted once. If a request times out, is cancelled, or returns an invalid target, a split may already exist. Inspect cmux before retrying; the extension never closes an unverified surface or guesses a replacement.

### Browser annotations

The **Annotate** toggle appears automatically when `/cmb` or `cmux_open_browser` opens a browser. No extra slash command is needed. It starts **off**, so page clicks work normally. Switch it **on** to select an element and type in the small note overlay. The toggle stays visible while writing; switching it off cancels a pending submission and preserves the draft in that document. Switching back on restores it.

Each browser has its own toggle and draft. Up to four annotation bridges can run per Pi session to bound background polling. Pi shows only one confirmation dialog at a time, even if several browsers submit notes.

Optional recovery commands:

```text
/cmba
/cmba surface:2
/cmba off
```

`/cmba` retries the bridge when exactly one browser is bound; supply a surface when several are bound. `/cmba off` stops all bridges without closing browsers or clearing drafts. The `cmux_annotate_browser` tool provides the same recovery controls: `surface` selects a bound browser; `enabled: false` stops that bridge, or all bridges when `surface` is omitted. Starting/retrying a bridge does not turn its page toggle on. A fifth browser still opens normally, but needs a bridge slot freed before its toggle can be added.

**Send** (or ⌘/Ctrl+Enter) queues one submission. Pi shows a compact confirmation with a one-line note preview and **Cancel / Send to Pi**, defaulting to **Cancel**. Use Down to select **Send to Pi**, then Enter; Escape cancels. There is no full-screen review or mandatory paging. Both terminal and RPC clients use the same selector. The preview is shortened to 60 terminal columns; approval sends the full note and page context, not just the preview. Approval dispatches a steering message and starts a new turn if Pi is idle. The confirmation expires after two minutes. **×** or Escape in the browser cancels the pending note and closes the overlay, retaining the draft in that document.

The bridge sends the comment, page URL (including query/fragment), title, selector hint, and up to 240 characters of selected visible text. Comments are limited to 2,000 characters and 20 lines; page URLs to 2,048 characters. It does not capture screenshots, full-page HTML, or form values. Text excerpts are omitted for form controls, editable elements, and containers containing either. Alternate line separators are normalized in the overlay and rejected in forged protocol submissions. Check the page and your note for sensitive information before submitting; the compact confirmation does not display the full page context.

**Trust boundary:** the overlay runs in the page's JavaScript world. Page scripts can inspect drafts, alter the overlay, and forge submissions. Routing markers are not authentication. Confirmation in Pi is always required, including on localhost; there is no automatic approval mode.

Polling runs about every 1.5 seconds while annotating and every 5 seconds while off, after the previous poll completes, with bounded CLI calls and one pending submission per browser. It continues during confirmation so observed cancellation, navigation, or selection changes can invalidate approval. The exact submission and bound surface are rechecked immediately before dispatch. Acknowledgements are deduplicated within the active bridge; a lost acknowledgement never automatically resends a message. “Queued in Pi” means handed to Pi's message API, not that the model has finished or delivery succeeded downstream. Re-enabling starts a new bridge; old pending submissions are not replayed. A bridge accepts at most 128 submission IDs before it must be restarted.

Full navigation reinjects the launcher in the new document but cannot preserve drafts from the old page. Same-document URL changes and detached or changed selections invalidate pending notes. Pi shutdown, `/reload`, session replacement, or session-tree navigation stop the bridge and cancel pending approvals. A browser creation that completes after tree navigation remains open but does not automatically start annotations; use `/cmba` explicitly to enable it. The page detects a missing heartbeat within about 20 seconds and disables Send while retaining its current draft. Heartbeat recovery restores disconnect detection without replaying expired submissions. Three consecutive verification failures stop polling and report the reason and browser reference, without claiming drafts survived. Closed or moved targets are never replaced by the focused browser.

A single session-scoped `cmux events` listener starts lazily when a browser is bound. Native `surface.closed`, `workspace.closed`, and `window.closed` events cancel affected approvals, stop their bridges quietly, and remove the bindings; closing the source terminal invalidates its browsers too. Move events trigger inventory checks rather than adopting a new target. Initial subscription and reconnects reconcile the current inventory, covering missed events; failed inventory checks retry with backoff from 1 to 30 seconds even while the event stream stays connected. A changed cmux boot ID invalidates old bindings. The reader has bounded frames, a heartbeat timeout, and reconnect backoff. The listener and inventory retries stop when no bindings remain or Pi shuts down/replaces the session; late browser-open results cannot restart them. If events are unavailable, annotation target checks still remove confirmed missing targets quietly; CLI errors or malformed replies alone are not proof of closure. No native hooks or sidebar configuration changes are required.

This uses an injected Shadow DOM overlay, not native Design Mode. If native Design Mode is active, annotations refuse to run rather than discard its draft. There are still no model-facing navigation/click/typing tools, no iframe annotation support, and no protection against manual navigation or unrelated automation. There is no atomic cross-process guard against navigation or cancellation in the interval after final verification and dispatch.

Annotations require a loaded HTML document, Pi's interactive or dialog-capable RPC UI, and cmux's `surface.list`, `browser.eval`, and `browser.design_mode.status` RPCs (tested with cmux 0.64.25). After `/reload`, open a new browser with `/cmb` to get the toggle; old bindings are intentionally not adopted.

Repository UI fixture: open `examples/browser/annotation-preview.html` as a local file URL for the standalone mock, or append `?live=1` to use the bare sample page with the automatically injected toggle. The mock never sends Pi messages.

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

Each configured command opens a right cmux split by default and runs via an inner `/bin/sh -c` in the current project directory, preserving the calling Pi process's `PATH`. cmux's outer login shell may still load profiles; see [Tool splits and tabs](#tool-splits-and-tabs).

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

Configured command names cannot reuse built-in Pi commands such as `/settings`, `/model`, or `/reload`, and they cannot replace `pi-cmux` commands such as `/cmn`, `/cmb`, `/cmba`, `/cmv`, `/cmo`, `/cmz`, or `/cmcv`.

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

## User-provided review workflows

`pi-cmux` does not provide review commands, skills, or prompt templates. Start a normal Pi session and request your preferred review workflow:

```text
/cmn Review this diff using my review skill
/cmv Review src/auth.ts using my review skill
```

Or ask Pi to start a review chat in a new split with `cmux_start_pi`. The supplied prompt selects the review tooling; `pi-cmux` does not prescribe it.

The former `/cmrv`, `/cmrh`, `/review-v`, and `/review-h` commands are no longer registered or reserved, so other packages or configured shortcuts can use those names.

## Environment variables

```bash
PI_CMUX_NOTIFY_LEVEL=all|medium|low|disabled
PI_CMUX_NOTIFY_FORCE=0|1
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
