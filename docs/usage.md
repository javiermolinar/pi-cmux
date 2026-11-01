# pi-cmux usage

Run Pi inside cmux. See [installation](../README.md#install).

## Commands

| Task | Command |
|---|---|
| New sidebar chat | `/cmn <prompt>` |
| Pi right/below | `/cmv [prompt]`, `/cmh [prompt]` |
| Return to origin | `/cmbk` or **Ctrl+Alt+B** |
| Jump to pane | `/cm` or optional `PI_CMUX_SWITCHER_KEY` |
| Peer messages | `/cmmsg inbox`, `/cmmsg status`, `/cmmsg on`, `/cmmsg off` |
| Continue right/below | `/cmcv [note]`, `/cmch [note]` |
| Continue in worktree | `/cmcv -c <branch> [--from <ref>] [note]` |
| Tool right/below/tab | `/cmo <cmd>`, `/cmoh <cmd>`, `/cmt <cmd>` |
| Browser | `/cmb [--down] [--focus] <url>` |
| Retry/stop annotations | `/cmba [surface]`, `/cmba off` |
| Jump directory right/below | `/cmz <path-or-query>`, `/cmzh <path-or-query>` |

Aliases: `/cmux-v` → `/cmv`, `/cmux-h` → `/cmh`, `/cmov` → `/cmo`, `/z` → `/cmz`, `/zh` → `/cmzh`.

**Inspect failed opens before retrying:** creation may have succeeded. The package never retries creation automatically.

## Configuration

Settings go in `~/.pi/agent/settings.json` (or `$PI_CODING_AGENT_DIR/settings.json`) and project `.pi/settings.json`. Project settings override global settings; `/reload` applies changes.

Set environment variables before starting Pi. `/reload` cannot import exports from another shell.

### Agent panel auto-open

```json
{ "pi-cmux": { "panel": { "autoOpen": true } } }
```

`pi-cmux.panel.autoOpen` defaults to `false`; a project boolean overrides the global boolean. Only literal booleans are accepted; malformed/unreadable settings or invalid panel options disable this attempt. Missing settings inherit normally. No user settings are written automatically.

Requires the separately installed repository prototype at `~/.config/cmux/sidebars/agent-state-panel.js` (a regular file) and interactive Pi in a verified ordinary-local cmux workspace with exact caller UUIDs. It opens **agent-state-panel** once at startup or explicit `/reload`, targets that workspace's window and uses `--no-focus`. It neither installs the panel nor enables cmux's custom-sidebar beta. Unsupported commands, timeouts or other failures never trigger a retry.

There is no visibility watcher: manual closure remains respected for that runtime, and `/new`, `/resume`, `/fork`, session updates and agent turns do not reopen it. Shutdown/session replacement fences pending opens. New Pi processes and explicit extension reloads can make a new configured attempt. Headless/SDK/RPC/print runs, missing panels and remote-owned/unverified workspaces do nothing. Setting `false` stops auto-open; it does not close a panel that cmux restores from its own saved UI state.

## Pi sessions

```text
/cmn Investigate slow startup
/cmv Review the auth flow
/cmz ~/src/other-project
```

These start independent chats. Explicit paths need no zoxide; fuzzy queries do. Quoted prompts preserve leading dashes; `@` inputs retain Pi's file-input behavior.

Ask Pi to start a session to use `cmux_start_pi`. It accepts workspace/right/down/tab placement, title, focus, provider/model and thinking. `cwd` accepts existing absolute, relative or `~/…` directories; omission keeps the current directory. It cannot accompany `continueSession: true`. Sessions focus by default; `focus: false` opens in the background.

### Pi startup guard

`cmux_start_pi` distinguishes creation, command dispatch, and observed Pi startup. After a confirmed launch dispatch, it checks the exact returned surface UUID for the launched conversation’s live orientation binding for up to 10 seconds.

- `details.startup.state: "bound"` means that exact Pi conversation published a live binding. It does not confirm prompt processing, task readiness, or completion.
- `"unconfirmed"` returns an explicit warning rather than claiming a started handoff. The child may still be starting, blocked on startup, or already exited. Inspect the returned surface before retrying. Standalone/older launches without orientation or a returned surface UUID cannot be verified and also remain unconfirmed.
- Transport failures distinguish unconfirmed workspace creation from an already-created surface whose command dispatch was not confirmed. Errors include known target refs and command byte count, not the launch command itself. A long command plus `Socket closed before reply` can match cmux 0.65.2’s known routing bug, but does not prove that diagnosis.

The owning parent UI receives startup warnings/errors without a new model turn. Verification is bounded and read-only: no automatic retry, respawn, focus change, child cancellation, or terminal cleanup. Timeout is not proof that the child failed, and this is not an ongoing child-process monitor. The guard does not work around cmux’s large-request bug.

### Pi launch PATH

Default `PI_CMUX_PI_PATH_MODE=minimal` resolves executable Pi/Node directories on caller PATH, invokes Pi by absolute path and prepends those directories to the child's own PATH. Relative entries resolve before changing cwd. Both PATH modes propagate to child Pi launches. Missing executables in minimal mode or an invalid mode stop creation without fallback.

Other tools may resolve differently or be missing. To preserve caller PATH:

```sh
export PI_CMUX_PI_PATH_MODE=full
```

Local helpers retain caller PATH; remote SSH operations retain remote PATH. Aliases/functions are not copied. Workspace create + respawn and standalone legacy launches may run cmux login profiles before applying PATH. Compact launch data reduces payloads but does not guarantee compliance with [cmux 0.65.2's 4 KiB routing limit](https://github.com/manaflow-ai/cmux/issues/21222).

## Conversation orientation

Tabs show topic, role and task tag: `Check login · review [ab12]`. Tags are labels, not unique targets.

| Option | Relationship/history |
|---|---|
| Default | Independent task, fresh history |
| `related: true` | Same task, fresh history |
| `role: "review"` | Same-task reviewer, fresh history |
| `continueSession: true`, `/cmcv`, `/cmch` | Same task with handoff context |

`related: false` conflicts with review/continue. Writing “review” in a slash prompt does not select a role.

### Return to the exact conversation

`/cmbk` returns to the immediate creator, including after tab moves. It validates the live Pi identity; a native `cmux://` link only selects the tab and is limited to the current cmux run. Neither grants messaging or execution authority.

`PI_CMUX_RETURN_KEY` changes the shortcut; `off` disables it without removing `/cmbk`. Related/handoff chats receive an origin note without copying history or waking an empty chat. Stale, closed or repurposed origins report unavailable rather than selecting a substitute.

### Persistence and compatibility

Reload/resume preserves a session's identity. `/new`, another session and `/fork` use their own identities; tree navigation follows the active branch. `/name` changes the topic, not the task marker. After sleep, live bindings may need a few seconds to renew. See the [orientation contract](pane-orientation-design.md).

## Pane switcher

`/cm` opens a transient overlay with every switchable cmux surface: terminal tabs and browser tabs across your workspaces. It reads the live layout on each opening, shows no layout preview, changes neither sidebar and stores no pane registry.

- **Type to filter** by workspace, tab title, browser URL, surface type, agent name or agent state. Matching is case-insensitive and every word must match.
- Unfiltered, rows are grouped by workspace with the current workspace first and a `· you` marker on this conversation. Workspace headers stay visible when scrolling within a group. Filtering flattens the list and shows a bounded workspace label beside each tab title, leaving room for the title. Window numbers distinguish multiple windows; workspace numbers distinguish repeated workspace names within a window.
- On short terminals, the overlay drops borders and hints before hiding result metadata. If even the input, workspace header and tab cannot fit, it shows **Resize terminal** and ignores Enter until the terminal grows; **Esc** still closes it.
- **↑↓** selects, **Enter** jumps, **Esc** or **Ctrl-C** closes. Enter with no matches does nothing.
- Agent labels such as `pi · working` come only from cmux metadata. When cmux reports no agent for a tab, the row shows the surface type (`terminal`, `browser`). In a reused tab, ended sessions are ignored while a live one exists; a tab whose only reported session has ended shows that state, and several live agents on one tab leave it unlabeled rather than guessing.

Jumping re-reads the layout and matches the exact surface UUID, so a moved tab still resolves correctly. Closed, ambiguous or unconfirmed targets report an error and never fall back to a nearby pane, title or index. The overlay only focuses; it never creates panes, types into terminals or starts a model turn.

`PI_CMUX_SWITCHER_KEY` adds an optional Pi-local shortcut (`off` by default):

```sh
PI_CMUX_SWITCHER_KEY=ctrl+alt+p pi
```

`off` or an invalid value disables only the shortcut; `/cm` keeps working. A value equal to `PI_CMUX_RETURN_KEY` is refused with a warning so `/cmbk` stays predictable. Set it before starting Pi: `/reload` cannot import exports from your shell. This is a Pi keybinding, not a cmux-wide or macOS-global shortcut, so it only works while Pi has focus.

## Peer messaging (experimental)

Requires Pi **1.3.0+** and native cmux messaging APIs, tested on **0.65.2**.

```text
Have another Pi review these changes without editing files and bring the findings back here.
```

`cmux_start_pi.returnResults: true` enables automatic return for a fresh delegated task. It implies related and cannot accompany handoff/continue or `related: false`. Ordinary related/slash launches do not enable return.

- The child must call `cmux_message_send` with the supplied route. A pane answer or queued send is not proof of processing.
- The parent polls about every two seconds, waits while busy/pending/in a dialog, and schedules findings as follow-ups—not steering. Progress stays quiet; idle delivery may start a paid turn.
- Permission expires after 30 minutes. Abort, off, reload or session/branch changes stop new scheduling, not the child or accepted follow-ups.
- Findings are untrusted data, never authority for fixes or more workers. Bodies persist in history and may reach the provider.
- Delivery is best effort, not exactly once. Inspect unknown outcomes; never retry blindly or assume rollback.

`/cmmsg inbox` and `cmux_message_inbox` inspect without importing, ACKing or marking messages read. `/cmmsg on` observes but grants no return permission; `off` revokes it. Sends require a related peer's full surface UUID, agreed `requestId`, `kind` and text. Optional `replyTo` correlates replies; `id` preserves identity for a deliberate retry. See the [contract](agent-messaging-design.md) and [validation guide](agent-messaging-validation.md).

## Continuation and worktree handoff

```text
/cmcv Continue with tests
/cmcv -c fix/login --from main Add login tests
```

Same-checkout handoffs include a summary and available conversation branch. Worktree handoffs carry a summary, not full history or uncommitted files. Both leave the source open. The tool equivalent is `continueSession: true`, optionally with `branch`/`fromRef`. Use a fresh reviewer instead when no history should transfer.

## Tool splits and tabs

```text
/cmo hx
/cmoh npm run dev
/cmt k9s
```

Or ask Pi to use `cmux_open_terminal`. Local helpers preserve caller PATH and run `/bin/sh -c`. They require a verified local workspace, creation capabilities and exact UUIDs; startup uses one local-context RPC. Naming is best-effort after creation, including protected Pi tabs/splits. Workspace/legacy Pi paths name before respawn. Creation is not command completion.

With a ready SSH target, helpers default to remote cwd/PATH. Use `/cmt --local k9s` or tool `target: "local"` for the Mac; `--remote` requires readiness. Non-ready remote intent never falls back locally. See [SSH usage](ssh.md) and [helper compatibility/evidence](ssh-terminal.md).

## Browser splits

```text
/cmb http://localhost:3000
/cmb --down --focus file:///tmp/preview.html
```

Default: right split, no focus change. URLs must be absolute HTTP/HTTPS/local-file URLs without credentials; encode spaces. `cmux_open_browser` confirms creation, not page readiness.

### Browser annotations

1. Turn on **Annotate** (initially off), select an element and write a note.
2. Choose **Send**, then confirm **Send to Pi** in Pi. Default is Cancel.

Turning Annotate off keeps the draft; navigation can lose it. Up to four bridges can run. `/cmba [surface]` retries a bound browser; `off` stops bridges, not browsers. Retry does not switch the page toggle. Reload/session replacement/exit clears bindings; old panes remain open. Disable native Design Mode first; iframes are unsupported.

**Privacy:** pages can inspect drafts or forge submissions. Approve only recognized notes. Delivery includes the comment, full URL/query/fragment, title, selector and up to 240 characters of selected text; form/editable content is excluded. No screenshot is taken. The shortened preview does not show every transmitted field.

Approval can start a Pi turn; queued is not processed. Navigation/cancellation can race dispatch. Annotations do not expose model click/typing tools.

## Conversation tab titles

Model-generated topics default to off. Enable `PI_CMUX_AUTOTITLE=1` or `"pi-cmux": { "autotitle": true }` in settings.

After successful settlement, a background request names the current tab using up to four recent user/assistant texts, 300 characters each. No images/tool messages are sent; provider charges may apply. `/name` takes priority. Successful titles persist; clearing `/name` permits automatic naming again. Runs only in interactive cmux sessions.

| Variable | Effect |
|---|---|
| `PI_CMUX_AUTOTITLE=0|1` | Override settings |
| `PI_CMUX_AUTOTITLE_DISABLED=1` | Disable automatic topics, not markers |
| `PI_CMUX_AUTOTITLE_MODEL=provider/model` | Select a model; unknown models skip naming |

## Sidebar status/log

Default `detailed` shows status, progress, tokens and logs. `minimal` shows status/tokens and configured flashes, without package logs/progress. Neither changes native previews/activity/branch/path or removes old logs.

| Variable | Default / options |
|---|---|
| `PI_CMUX_SIDEBAR` | `1`; `0` disables package sidebar integration, not independent flash settings |
| `PI_CMUX_SIDEBAR_MODE` | `detailed`, `minimal` |
| `PI_CMUX_SIDEBAR_TOKENS` | `1`; `0` hides tokens |
| `PI_CMUX_SIDEBAR_COST` | `0`; `1` shows reported cost |
| `PI_CMUX_SIDEBAR_FLASH` | `all`, `error`, `disabled` |
| `PI_CMUX_SIDEBAR_PROGRESS` | `1`; `0` hides progress |
| `PI_CMUX_SIDEBAR_LOG_TOOLS` | `0`; `1` logs results |
| `PI_CMUX_SIDEBAR_LOG_PROMPT` | `0`; `1` logs truncated prompts |
| `PI_CMUX_SIDEBAR_FINAL_CLEAR_MS` | `2500` |

## Notifications

Off by default. Set `PI_CMUX_NOTIFY_LEVEL` to `all`, `medium` (completion/error) or `low` (error). Notifications wait for settlement and normally require interactive Pi inside cmux. `PI_CMUX_NOTIFY_FORCE=1` bypasses that context guard, not the level.

`PI_CMUX_NOTIFY_INCLUDE_RESPONSE=1` includes up to 500 response characters; leave off for sensitive conversations. Other settings: `PI_CMUX_NOTIFY_TITLE=Pi`, `PI_CMUX_NOTIFY_THRESHOLD_MS=15000`, `PI_CMUX_NOTIFY_DEBOUNCE_MS=3000`.

### Tool notification settings

```json
{ "pi-cmux": { "notify": { "tools": { "ask_user_question": true } } } }
```

Requires an enabled notification level. Bodies contain the tool name and optional path basename, not arguments. Project `{ "disabled": true }` removes a global entry; invalid settings warn.

## Pluggable tool commands

```json
{
  "pi-cmux": {
    "commands": {
      "edit": { "run": "hx", "acceptArgs": true },
      "dev": { "run": "npm run dev", "direction": "down" },
      "logs": "tail -f logs/app.log"
    }
  }
}
```

Use `/edit src/auth.ts`, `/dev` or `/logs`. Options: `run`, `acceptArgs`, `direction` (right/default or down), `title`, `description`, `target` (local/remote) and `disabled`. Omitted target follows helper defaults; forwarded arguments are program arguments, not locality flags. Project `disabled: true` removes a global shortcut. Names cannot replace Pi/package commands.

## Compatibility

Workspace/browser behavior was tested with cmux **0.64.25**; orientation, ordinary-local-workspace SSH helper/child tabs and the `/cm` switcher with **0.65.2**. The switcher was smoke-tested on 0.65.2 for multi-tab jumps inside one workspace and for exact focus back to the caller; several workspaces/windows and browser targets were exercised with fixtures, not live cmux, and remain unverified live. The 0.3.0 [local startup smoke](startup-smoke.md) passed for one no-prompt sidebar workspace and one protected local-context tab on **0.65.2** with Pi **1.4.0**, including exact child bindings and independent local process/cwd checks. Splits, other native layouts, long prompts and live transport failures remain unverified; no minimum cmux version is certified for protected creation. Missing capabilities or ambiguous identity fail without retry/substitute placement.

Launch commands longer than 1 KiB are sent as a short `/bin/sh` wrapper around a private `0600` script, so cmux socket requests stay small; this avoids cmux 0.65.2's 4 KiB request-classification bug ([#21222](https://github.com/manaflow-ai/cmux/issues/21222)), where long prompts could create a pane and then fail with `Socket closed before reply`. Leftover scripts are removed after an hour.

Bundled Pi tabs/splits use protected local-context creation. Local sidebar workspaces still use create + respawn; standalone legacy Pi paths can use discovery/respawn. These paths may run login profiles. Remote-owned layouts and SSH worktrees/handoffs/zoxide/new browser previews are refused. See [SSH limits](ssh.md#limits).
