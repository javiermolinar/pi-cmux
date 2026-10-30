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

## Pi sessions

```text
/cmn Investigate slow startup
/cmv Review the auth flow
/cmz ~/src/other-project
```

These start independent chats. Explicit paths need no zoxide; fuzzy queries do. Quoted prompts preserve leading dashes; `@` inputs retain Pi's file-input behavior.

Ask Pi to start a session to use `cmux_start_pi`. It accepts workspace/right/down/tab placement, title, focus, provider/model and thinking. `cwd` accepts existing absolute, relative or `~/…` directories; omission keeps the current directory. It cannot accompany `continueSession: true`. Sessions focus by default; `focus: false` opens in the background.

Placement follows the task relationship unless explicitly supplied:

| Launch | Default placement |
|---|---|
| Independent task | New sidebar workspace |
| First active same-task agent or reviewer | Right split beside its creator |
| Further same-task agents after a remembered same-task split | Tab in the caller's workspace |
| Background same-task agent (`focus: false`) | Tab |
| Handoff (`continueSession: true` or `role: "continue"`) | Tab |

Explicit placement always wins, including a separate workspace for a reviewer. Repository changes alone do not select placement: use `related: true` or `role: "review"` for the same task, even across directories. `/cmn` stays independent; explicit split/continuation commands retain their directions.

### Pi startup guard

`cmux_start_pi` distinguishes creation, command dispatch, and observed Pi startup. After a confirmed launch dispatch, it checks the exact returned surface UUID for the launched conversation’s live orientation binding for up to 10 seconds.

- `details.startup.state: "bound"` means that exact Pi conversation published a live binding. It does not confirm prompt processing, task readiness, or completion.
- `"unconfirmed"` returns an explicit warning rather than claiming a started handoff. The child may still be starting, blocked on startup, or already exited. Inspect the returned surface before retrying. Standalone/older launches without orientation or a returned surface UUID cannot be verified and also remain unconfirmed.
- Transport failures distinguish unconfirmed workspace creation from an already-created surface whose command dispatch was not confirmed. Errors include known target refs and command byte count, not the launch command itself. A long command plus `Socket closed before reply` can match cmux 0.65.2’s known routing bug, but does not prove that diagnosis.

The owning parent UI receives startup warnings/errors without a new model turn. Verification is bounded and read-only: no automatic retry, respawn, focus change, child cancellation, or terminal cleanup. Timeout is not proof that the child failed, and this is not an ongoing child-process monitor. The guard does not work around cmux’s large-request bug.

### Pi launch PATH

Set `PI_CMUX_BINARY` before starting Pi to use a Pi-compatible wrapper for all child sessions (workspaces, splits, tabs and handoffs):

```sh
export PI_CMUX_BINARY=sumocode
```

Unset or blank values default to `pi`. Supply one executable name or path, not arguments or shell code; aliases/functions and `~` expansion are not supported. Names resolve on the caller's PATH; relative paths resolve from the calling Pi process's working directory before the child changes cwd. Overrides are checked for executability in both PATH modes, shell-quoted and passed to descendants as absolute paths. Invalid overrides stop creation without falling back to `pi`. Wrappers must accept and forward Pi's CLI arguments, including `--session`, provider/model/thinking options and the `--` prompt separator.

Default `PI_CMUX_PI_PATH_MODE=minimal` resolves the selected executable and Node, invokes the executable by absolute path and prepends their directories to the child's own PATH. Relative PATH entries resolve before changing cwd. Both PATH modes propagate to child Pi launches. Missing executables in minimal mode or an invalid mode stop creation without fallback.

Other tools, including a wrapper's underlying `pi`, may resolve differently or be missing. To preserve caller PATH:

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

The creator remembers up to 64 successfully dispatched children in memory, using exact task/conversation/parent/surface identities. `cmux_start_pi` results expose these direct relationships in `details.children`. Binding states are `unconfirmed` (no live child binding observed), `bound` (exact live identity observed), or `unknown` (binding lost, invalid or replaced). None proves task readiness or completion. Remembered same-task splits continue to favor tabs when their bindings become unknown; inspect cmux rather than automatically replacing them.

This is best effort, not a shared task-tree service: each creator knows only its own launches. Reload, session replacement and tree navigation clear child memory; existing parent/origin metadata still follows the session. Launches without an active orientation runtime or exact created UUID cannot be tracked. There is no layout reconstruction, child termination, automatic cleanup, or execution/messaging permission from the hierarchy.

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

`Connect to javi` defaults to the remote account's home; `in ~` is equivalent, while an explicit project path must be absolute. Home resolution never uses your Mac's home directory. With a ready SSH target, helpers default to remote cwd/PATH. Use `/cmt --local k9s` or tool `target: "local"` for the Mac; `--remote` requires readiness. Non-ready remote intent never falls back locally. See [SSH usage](ssh.md) and [helper compatibility/evidence](ssh-terminal.md).

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

Naming uses the project and an available task name without an extra model request:

- **New Pi workspaces:** repository basename, or directory basename outside git. An explicit launch `title` overrides this default. Existing workspaces are not renamed. SSH tab fallbacks use the selected remote directory name without probing the local repository.
- **Tabs:** use the launch title or task prompt, an existing session name, or a saved topic when available. Without a task name, use the project name instead of `Pi`. Tracked sessions retain their role/task tag, for example `Fix login · review [ab12]` or `pi-cmux · main [ab12]`.
- **Explicit names:** `/name` wins over the fallback. Launch titles are not automatically suffixed with the project name. Handoffs reuse an available session name; empty chats and directory jumps use the project fallback.
- **Reload/resume:** old generic `Pi` defaults upgrade to the project label without changing conversation identity. Saved task names remain available even when model-generated naming is off.

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

Off by default. Set `PI_CMUX_NOTIFY_LEVEL` to `all`, `medium` (completion/error) or `low` (error). Notifications wait for settlement and normally require interactive Pi inside cmux. `PI_CMUX_NOTIFY_FORCE=1` bypasses that notification context guard, not the level or the bundle's verified-cmux startup check.

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

Workspace/browser behavior was tested with cmux **0.64.25**; orientation, ordinary-local-workspace SSH helper/child tabs and the `/cm` switcher with **0.65.2**. The switcher was smoke-tested on 0.65.2 for multi-tab jumps inside one workspace and for exact focus back to the caller; several workspaces/windows and browser targets were exercised with fixtures, not live cmux, and remain unverified live. The 0.3.0 [local startup smoke](startup-smoke.md) passed for one no-prompt sidebar workspace and one protected local-context tab on **0.65.2** with Pi **1.4.0**, including exact child bindings and independent local process/cwd checks. A later [task-aware reviewer smoke](startup-smoke.md#task-aware-placement-follow-up) confirmed omitted placement resolving to a right split with an exact child binding. Other split/native-layout cases, long prompts and live transport failures remain unverified; no minimum cmux version is certified for protected creation. Missing capabilities or ambiguous identity fail without retry/substitute placement.

Launch commands longer than 1 KiB are sent as a short `/bin/sh` wrapper around a private `0600` script, so cmux socket requests stay small; this avoids cmux 0.65.2's 4 KiB request-classification bug ([#21222](https://github.com/manaflow-ai/cmux/issues/21222)), where long prompts could create a pane and then fail with `Socket closed before reply`. Leftover scripts are removed after an hour.

Bundled Pi tabs/splits use protected local-context creation. Local sidebar workspaces still use create + respawn; standalone legacy Pi paths can use discovery/respawn. These paths may run login profiles. Remote-owned layouts and SSH worktrees/handoffs/zoxide/new browser previews are refused. See [SSH limits](ssh.md#limits).
