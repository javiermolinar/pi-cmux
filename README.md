![pi-cmux — connected terminal panes on a dark background](docs/images/pi-cmux-banner.png)

[![CI](https://github.com/javiermolinar/pi-cmux/actions/workflows/ci.yml/badge.svg)](https://github.com/javiermolinar/pi-cmux/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pi-cmux.svg)](https://www.npmjs.com/package/pi-cmux)
[![Node.js ≥22.19.0](https://img.shields.io/node/v/pi-cmux.svg)](https://www.npmjs.com/package/pi-cmux)
[![Pi ≥1.3.0](https://img.shields.io/badge/Pi-%E2%89%A51.3.0-8b5cf6.svg)](https://pi.dev)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

[Pi](https://pi.dev) tools for [cmux](https://www.cmux.dev): parallel chats, terminal commands, browser annotations and task handoffs.

[Install](#install) · [Commands](#commands) · [Configuration](#configuration) · [Usage guide](docs/usage.md)

## Capabilities

- Start independent chats or related reviewers; return to their origin with `/cmbk`.
- Jump to any cmux terminal or browser tab with `/cm`: one transient, type-to-filter list of live panes.
- Run tools beside Pi, annotate browser pages and continue tasks in new worktrees.
- Show progress, tokens and optional notifications in the sidebar.

![Pi running inside a cmux workspace](https://github.com/user-attachments/assets/27806213-60f9-4c30-84d4-4a331ea1484b)

## Install

Requires **Pi 1.3.0+** and **Node.js 22.19.0+**, including the `pi` executable on your PATH.

```sh
pi install npm:pi-cmux
# Or install/update with:
npx pi-cmux
```

Run Pi inside cmux. Outside a verified cmux terminal, the package stays disabled: no commands, tools, shortcuts or lifecycle hooks are registered. A reachable cmux socket alone does not enable it.

For native notifications, session restore and prompt previews:

```sh
cmux hooks pi install
```

Package notifications default to off to avoid duplicate alerts. Zoxide is needed only for fuzzy directory matching.

## Commands

| Task | Command |
|---|---|
| New sidebar chat | `/cmn <prompt>` |
| Pi right/below | `/cmv [prompt]`, `/cmh [prompt]` |
| Tool right/below/tab | `/cmo <cmd>`, `/cmoh <cmd>`, `/cmt <cmd>` |
| Browser | `/cmb [--down] [--focus] <url>` |
| Browser annotations | Turn on **Annotate**; sending requires confirmation in Pi |
| Jump directory | `/cmz <path-or-query>`, `/cmzh <path-or-query>` |
| Return to origin | `/cmbk` or **Ctrl+Alt+B** |
| Jump to pane | `/cm` or optional `PI_CMUX_SWITCHER_KEY` |
| Continue task | `/cmcv [note]`, `/cmch [note]` |
| Continue in worktree | `/cmcv -c <branch> [--from <ref>] [note]` |
| Peer messages | `/cmmsg inbox`, `/cmmsg status`, `/cmmsg on`, `/cmmsg off` |

New Pi workspaces default to the project name. Tabs use an available task name, otherwise the project name plus role/task tag. Explicit launch titles and `/name` take priority; this policy makes no extra model calls. See [naming](docs/usage.md#conversation-tab-titles).

You can also ask Pi to open a tool, browser or another Pi session. Independent tasks default to new workspaces; the first active same-task agent/reviewer opens beside its creator, additional/background collaborators and handoffs use tabs. Explicit placement always wins. Best-effort in-memory child tracking avoids repeatedly splitting for the same creator; it is not a task supervisor or persistent registry. Use `role: "review"` for a same-task reviewer without copied history; `continueSession: true` hands off context. Opt-in `returnResults: true` returns delegated findings as best-effort follow-ups, not permission for fixes. See [usage](docs/usage.md).

**Inspect cmux before retrying a failed open:** a surface may already exist. Creation is never retried automatically. `cmux_start_pi` checks for the exact child’s live Pi binding for up to 10 seconds and warns the parent if startup remains unconfirmed; a binding is not task readiness or completion.

## Experimental SSH

```text
Connect to javi
# Or choose a project:
Connect to javi in /srv/project
```

Pi and its credentials/session files stay local; `ssh_read`, `ssh_write`, `ssh_edit` and `ssh_bash` use the explicit remote target. Helpers default to that project; `/cmt --local k9s` or tool `target: "local"` stays on the Mac. Omitted cwd or `~` defaults to the remote account's home, resolved remotely and stored as an absolute path. Complete requests need no extra gate; unresolved hosts or invalid paths are clarified one at a time. Alias saving is separate and requires an exact-preview confirmation.

SSH does not claim the local `read`, `write`, `edit` or `bash` names, so extensions such as `pi-tool-display` can retain them with SSH enabled. On connection, Pi selects only SSH counterparts of the previously selected local tools and blocks local file/shell counterparts, including nested calls. `/ssh-clear`, while idle, restores the prior available local membership. `pi-tool-display` does not automatically customize the new SSH tools. See [selection, guards and migration](docs/ssh.md#tool-selection-and-local-guards).

Resume/child launches restore selection, not readiness. Remote-owned layouts, SSH handoffs/worktrees and new browser previews are unsupported. See [SSH setup, controls and limits](docs/ssh.md).

## Configuration

Set environment variables before starting Pi. Package settings belong in `~/.pi/agent/settings.json` or project `.pi/settings.json`; project settings override global settings.

| Variable | Default | Purpose |
|---|---|---|
| `PI_CMUX_PI_PATH_MODE` | `minimal` | Prepend Pi/Node directories to child PATH; `full` preserves caller PATH |
| `PI_CMUX_SSH` | `1` | `0` disables SSH execution/connections; saved remote intent stays blocked until explicit clear |
| `PI_CMUX_SSH_DISCOVERY` | `1` | `0` disables SSH suggestions |
| `PI_CMUX_SSH_ALIAS_SAVE` | `1` | `0` disables alias saving |
| `PI_CMUX_NOTIFY_LEVEL` | `disabled` | Opt in with `all`, `medium` or `low` |
| `PI_CMUX_SIDEBAR_MODE` | `detailed` | `minimal` shows status/tokens without package logs/progress |
| `PI_CMUX_RETURN_KEY` | `ctrl+alt+b` | Change shortcut or set `off`; `/cmbk` remains |
| `PI_CMUX_SWITCHER_KEY` | `off` | Pi-local shortcut for `/cm`, e.g. `ctrl+alt+p`; not a cmux-wide binding |
| `PI_CMUX_AUTOTITLE` | `0` | Enable model-generated topics; sends conversation excerpts and may incur charges |

[All settings and shortcuts](docs/usage.md#configuration) · [PATH behavior](docs/usage.md#pi-launch-path) · [Browser privacy](docs/usage.md#browser-annotations)

## Compatibility

Bundled Pi tabs/splits and helper terminals require verified local workspace metadata and exact creation UUIDs. Remote-owned or unverified placement is refused. New sidebar workspaces still use create + respawn; cmux's outer login shell may run profiles before the launch PATH takes effect. Standalone legacy Pi launch paths can do the same.

Workspace/browser behavior was tested on cmux **0.64.25**; orientation, ordinary-local-workspace SSH helper/child tabs and the `/cm` switcher on **0.65.2**. The switcher revalidates exact surface UUIDs before focusing and leaves rows unlabeled when cmux reports no agent. The 0.3.0 [local startup smoke](docs/startup-smoke.md) passed for one no-prompt workspace and one tab on **0.65.2** with Pi **1.4.0**. A task-aware reviewer smoke also confirmed omitted placement resolving to a right split with an exact child binding. Other split/layout cases, long prompts and live transport failures remain unverified. See [compatibility details](docs/usage.md#compatibility) and [current SSH isolation smoke evidence](docs/ssh-isolation-live-validation.md). Historical helper/child evidence remains [separate](docs/ssh-native-validation.md).
