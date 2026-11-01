# Agent state panel (prototype)

[`agent-state-panel.js`](agent-state-panel.js) is a reactive **cmux right panel**. It keeps the stock left sidebar available. This prototype asset ships in the npm package alongside the shared Node-only installer helper. Use **`/cmdoctor`** in Pi for diagnostics and explicit setup; no worktree or pinned launch configuration is required. The panel itself is a cmux custom sidebar, not a Pi extension.

The roster shows workspace rollups, agent states, scope/search, unread notifications and optional git/PR/progress details. Agent rows use a sidebar alias when set, otherwise the task title, tab's latest prompt or **Untitled session**. Redundant **Pi** labels are omitted from the secondary line; other agent names and unread/subagent/navigation details remain. State labels appear on agent rows; there is no footer legend. Use each workspace's chevron to fold its agent list; the title/metadata still select the workspace. Fold choices stay local to the panel until it reloads, preserve rollup counts and never reorder or navigate. Search temporarily expands matching groups; clear it to restore folds. The current agent surface gets a blue wash and semibold title only when its workspace is selected and its exact live tab is focused. Workspaces without tracked agents are hidden in both scopes, even if their title matches search or they have lane/unread evidence. Only the most recently active session per exactly resolved live terminal is shown, using cmux's most-recent-first session order (also the tie-breaker). Older sessions on that terminal are excluded before search, Attention filtering, state sorting and display caps. Distinct terminals and agents without an exact live binding remain separate. Idle, ended and unknown agents remain visible unless superseded on the same terminal. The panel has no workspace creation button; **+ New Pi** has been removed.

## Sidebar names

Right-click an agent row → **Name in sidebar…**, enter a one-line name (1–80 characters), then **Save** or Enter. Escape/**Cancel** discards the edit. **Use automatic name** removes the alias and restores the title/prompt fallback.

Aliases stay stable as prompts, status, search and scope change. Search matches both aliases and original task/prompt text. They are keyed by workspace + agent ID, so duplicate names/IDs elsewhere do not share labels; stale targets cannot be renamed. They are **in-memory only, until the panel reloads** and do not follow an agent moved to another workspace. No cmux tab/workspace title, Pi session metadata, filesystem or other host state is changed.

## Attention filter

Click **Attention** in the header to show only agents with explicit `needs_input` state or an unread notification on their exactly resolved live tab. It starts off and turns amber when enabled; click again to show all tracked agents. Working, idle, ended and unknown agents can match through unread evidence without changing their actual state. Workspace unread counts or status lanes alone do not identify an agent and do not qualify it.

The filter combines with workspace scope and search, applies before display caps and preserves fold choices. It changes only this panel: no navigation, notification-read action, creation or model turn. Like scope/folds, it resets when the panel reloads.

## State contract

| Symbol | Color | Agent evidence |
| --- | --- | --- |
| `!` | Amber | `needs_input`; a separate `! unread` label flags surface notifications |
| `●` | Blue | `working` |
| `✓` | Green | `ended`: ended/review, **not** proof of success or approval |
| `○` | Native secondary | Explicit `idle` only |
| `?` | Purple | Missing or unrecognized state |

Workspace rollups combine **all** agents, workspace lanes and unread evidence, in this priority order:

1. Attention: an agent needs input, workspace/surface unread, or `needs-attention` lane.
2. Working: a working agent or `working` lane.
3. Review: an ended agent or `review`/`done` lane.
4. Unknown: unknown agents.
5. Idle: remaining tracked agents are explicitly idle.

Unread is attention, not proof of pending input. Workspace lanes never overwrite individual agent states. `todo` alone does not prove a session is idle. Ended agents remain visible while cmux retains them unless a newer session shares their exact live terminal; child runs are summarized under the parent, not separately focusable sessions.

Header counts cover agents matching the selected scope and Attention filter, independent of search. Workspace counts/rollups cover the complete deduplicated roster in each workspace, independent of Attention/search/display limits. Rendering is capped at **12 matching workspaces × 6 agents**, attention first within each workspace, with overflow notes. Search can reveal capped rows. Workspace order follows cmux; there are no reorder or destructive actions.

## Exact navigation

- Workspace header → `workspace.select` with that workspace's `id`.
- Agent row → re-resolve its workspace and agent, resolve exactly one live tab, select the workspace, then `surface.focus` with **both** `workspace_id` and that tab's current `surfaceId`.
- With an explicit agent `panelId`, match it to the tab's `id` first; without it, require an exact agent/tab `surfaceId` match. cmux 0.65.2 can put a Bonsplit ID in an agent's `surfaceId` while its tab exposes the RPC surface ID, so those fields are not interchangeable. Never send `panelId`, tab `id` or a legacy Bonsplit ID directly to `surface.focus`. Missing/stale/ambiguous targets select the workspace only; removed workspaces/agents and superseded sessions produce no action.

These checks use the latest sidebar snapshot (~1-second refresh), not an atomic socket transaction. A target can disappear between click and dispatch. The host handles RPC failures; the panel does not retry actions or explicitly mark notifications read.

## Retained launch experiment (not exposed in the panel)

The launch form helpers and bootstrap remain **tests-only historical experiment code**, not a supported setup or launch workflow. The production installer does not pin executable/bridge paths; the installed panel has no control that opens the form. The following describes the historical fixture configuration only, not current installation.

The custom-sidebar sandbox cannot directly call a Pi extension. Its `cmux()` action pipe also does not return RPC results. Instead:

1. The historical launch fixture pinned absolute Node, Pi, cmux and [`launch-pi.mjs`](launch-pi.mjs) paths in its experimental JS. No credentials or conversation data are embedded. A raw copied panel remains a read-only roster; it cannot guess a launch command from cmux's app PATH.
2. The internal form helper displays the selected ordinary-local workspace's directory. You can edit it to another absolute local directory or `~/path`; there is no hidden cwd fallback. **Create** is a second explicit action.
3. One native `workspace.create` action, routed using the source workspace ID, starts the fixed bootstrap as `initial_command` in a **new** workspace. Literal shell arguments protect paths/JSON, including quotes and shell metacharacters. There is no terminal-input injection or intermediate helper tab.
4. The bootstrap checks the directory exists, validates its exact cmux terminal identity, and reuses pi-cmux's `assertLocalWorkspace` checks for both source/new workspaces. Remote-owned, missing or ambiguous locality is refused before Pi starts.
5. It reuses `buildPiCommand` and starts one child with minimal PATH, Pi defaults, no prompt/session/resume flags, fresh task/conversation IDs and **no origin**. Inherited SSH/session/model metadata is removed. It deliberately does not call `openPiSession`, which would create a second workspace and attach an originating Pi conversation that a panel click does not have.
6. It reuses the shared bounded `waitForPiBinding` guard (10 seconds) against the exact new surface and conversation. A confirmed binding clears the temporary startup status; an unconfirmed launch leaves a status warning and workspace log. Binding is not task readiness or completion. No automatic retry, cleanup, messages or model turn occurs.

The form locks after dispatch and says **Request sent**, never "session ready". Close/reopen it only for a deliberate new attempt, after inspecting any workspace already created.

Limitations: cmux creation errors cannot be returned to the form; invalid/missing directories may be rejected by cmux, and a later bootstrap failure leaves an empty/ended workspace with an explanation in its terminal. A stale source can also prevent startup after creation. The native outer login shell can run profiles before the bootstrap's checks, as with existing workspace launches. The bootstrap does not undo an already-created workspace. Only independent **local new workspaces** are supported—no same-workspace tabs, SSH targets, prompt entry, model picker, handoff, related-task marker or return-to-origin link. Native agent state tracking still needs `cmux hooks pi install` where not already configured.

## Opt-in installation / preview

Requires Node **22.19.0+**, Pi **1.3.0+** and compatible cmux custom-sidebar support (native read-only discovery observed on **0.65.2**). Check **Settings → Custom Sidebars** manually: doctor cannot verify or enable the beta.

Install `pi install npm:pi-cmux`, then invoke **`/cmdoctor`**. Read-only diagnostics are available even outside verified cmux, while all normal workflows stay guarded. The active-theme, Powerline-inspired native Pi overlay has selected-error details/remediation, responsive side-by-side/stacked layouts, **Tab/Shift-Tab** focus, **arrows** navigation, **Enter** actions, **PgUp/PgDn** details and **Esc** close. There is no automatic dismissal. Below **42 columns × 18 rows** actions are disabled. Non-interactive/unavailable UI uses plain text without a model turn.

Choose **Refresh (read-only)** to recollect; **Install/update panel** for a separate confirmation; **Show Pi Agents (no focus)** for a separate single exact verified-local-window request, or **Hide right sidebar** to hide that window’s entire right sidebar. Both actions revalidate the original local caller; neither edits settings or retries. cmux 0.65.2 excludes custom panels from its mode-tab bar, so Show selects Pi Agents directly without adding a native Custom tab. Invocation never installs, opens, edits settings, enables beta, performs network setup or changes startup behavior. Capability query failures/missing required methods are errors, not healthy results; advertised methods do not establish permissions. See [diagnostics and remediation](../../docs/usage.md#diagnostics-and-remediation).

The npm payload includes `agent-state-panel.js` and `lib/panel-install.mjs`; the helper works from an extracted package with Node built-ins only. It renders a managed checksum header over the canonical asset, without pinned launch paths or worktree imports. Doctor warns on legacy/modified copies, confirms the exact raw-byte full-file SHA-256 and existing permission mode before replacement, preserves that mode in the replacement and backup, rejects symlink leaves/ancestors and stale content/paths, and preserves the old content in an exclusive `.backup-<timestamp>` file. Cancellation changes nothing. Keep/compare backups before manually restoring a desired copy; Refresh after recovery. Installation does not open or natively validate the panel.

Optional contributor route: the repository-only CLI below reuses shared installation logic but is **not shipped in npm**. It is not required for production setup:

```sh
node examples/sidebars/install-agent-state-panel.mjs
cmux sidebar validate agent-state-panel
cmux right-sidebar set custom agent-state-panel --no-focus
```

The installer does not activate anything itself, modify `cmux.json` or install hooks. It refuses to replace an existing file with different contents. To update a copy you have inspected:

```sh
# Explicit exact-content replacement; the installer also saves a backup.
installed="$HOME/.config/cmux/sidebars/agent-state-panel.js"
shasum -a 256 "$installed"
node examples/sidebars/install-agent-state-panel.mjs --replace <the-observed-sha256>
cmux sidebar validate agent-state-panel
```

There is no worktree keep-path requirement for the production panel. Source/asset files remain unchanged during installation; edits to a checkout do not update an installed copy automatically. Explicitly install/update again. The installed JS hot-reloads when replaced. `/cmdoctor` is the production setup command; there is no `/cmpanel` command.

To opt into opening this already-installed panel when pi-cmux starts, set `"pi-cmux": { "panel": { "autoOpen": true } }` in Pi's agent-directory or project `settings.json` (default **false**). A project `false` overrides global `true`; malformed/invalid settings fail closed. Startup or explicit `/reload` attempts one non-focusing open in the verified ordinary-local caller workspace's window. It skips headless, missing/non-file panels and unverified/remote-owned contexts, does not install/enable anything, and never retries or reopens on `/new`, `/resume`, `/fork` or agent updates. Disabling the setting does not hide a panel cmux already remembers as open.

The right-panel command keeps terminal focus and does not select a custom left sidebar. Doctor targets only the exact originally verified caller's window; it does not guess or offer arbitrary-window placement. To stop previewing, use `cmux right-sidebar hide` or restore the right-panel mode you used before. Remove only the prototype copy/backups you installed if you no longer want them.

### Live acceptance checks

- Resize around 280–360 points and check light/dark clipping, including the Attention button. Confirm **+ New Pi** and the launch form are absent.
- Right-click an agent to name it, then check prompt updates, search, Cancel/Escape and **Use automatic name**. Native menu hit targets/editor focus still need manual verification.
- Toggle Attention, search and switch workspace scope. Verify only explicit needs-input or exact-surface unread agents remain and that clearing unread/changing state removes them without marking anything read.
- Compare working/input/ended/idle/unread states against cmux metadata. Workspaces without tracked agents should stay hidden; add/remove the last tracked agent and check the workspace appears/disappears. Unknown agents must not show as idle.
- Click agents across workspaces/tabs; verify exact focus and current-agent highlight. Fold/unfold groups, search through a folded group, clear search and check the fold returns. Search, switch scope, end/move/close sessions and check reactive updates.

**Historical prototype evidence only:** an earlier panel was installed/enabled at the user's request, with previous copies backed up; native cmux validation reported 1 valid, 0 invalid. The doctor-validation native checks did **not** install the latest production panel or actually open it in live Pi. See [current evidence and limits](../../docs/doctor-validation.md).

**Live smoke, 2026-11-01 (before removing the New Pi button):** the installed JS ran in cmux's bundled scene runtime with native cmux RPC dispatch. Cancel created nothing; Create dispatched once and opened one real Pi workspace in this worktree. Its exact surface published a live binding with fresh task/conversation IDs, `main` role and no inherited origin/resume flags. The child was empty (0 tokens), its process cwd matched this worktree and its temporary startup status cleared. Agent-row events navigated origin → child → origin; native identity queries confirmed exact workspace/surface IDs and restored the caller. Fold/unfold events changed only the scene; current-agent state followed the selected workspace/tab.

The first native screenshot exposed cmux 0.65.2's differing agent/tab surface IDs. A temporary read-only diagnostic confirmed the explicit panel binding, the resolver was fixed and the smoke was rerun. A subsequent native screenshot showed the caller's agent highlighted and both live agents resolving to surfaces (no false `workspace only`). The diagnostic was removed. Reports remain locally at `/tmp/pi-cmux-panel-smoke-20261101.json` and `/tmp/pi-cmux-panel-smoke-20261101-fixed-mapping.json`.

These were runtime event dispatches, **not mouse clicks**. Native hit targets, cross-tab/multi-window navigation, all light/dark/width combinations and reactive native folding still need manual checks. cmux refused to close the final test workspace while Pi was running; no forced close was attempted.

## Local validation

```sh
node --check examples/sidebars/agent-state-panel.js
node --test tests/agent-state-panel.test.mjs tests/cmux-panel-launch.test.mjs tests/cmux-panel-auto-open.test.mjs tests/cmux-startup.test.mjs
npm run typecheck
npm test
npm run pack:check
```

Tests cover latest-session-per-terminal deduplication across resets, counts/rollups, attention/search/caps, stale navigation/naming callbacks and reactive single-row highlighting; default-off opt-in startup, project overrides, headless/missing-panel/locality refusal, cancellation and no replay after close/failure, stable workspace-qualified aliases, search/reset/cancel/input limits and stale naming targets, reactive Attention filtering with scope/search/counts and exact unread ownership, task/prompt/fallback names, redundant Pi-label removal and retained non-Pi/details metadata, state precedence, unknowns, empty-workspace exclusion across scopes/search/caps and last-agent transitions, local folding/search reveal, exact focused-agent highlighting, search/counts/caps, native panel-to-surface mapping and exact/stale/ambiguous targets, creation/cancel/single-shot behavior, literal shell argv, local identity/refusal checks, independent child environment, exact startup evidence and installer replacement/backup protection. A subprocess integration test runs the real bridge against **fake** Pi/cmux executables; it confirms startup binding and early-exit warning paths without touching the actual socket or starting an agent.

When the installed macOS `SidebarRuntime.js` exists, scene tests use that **real bundled JS runtime** in a Node VM to check reactive rows, context-menu naming/editor events, UI events, the absence of the New Pi button, retained internal form helpers and bounded scene size. Otherwise they skip; `CMUX_SIDEBAR_RUNTIME=/path/to/SidebarRuntime.js` enables them. A separate local Swift/JavaScriptCore fixture check also passed. These checks do not establish native SwiftUI layout or live workspace creation/focus behavior.

Those earlier prototype results are not a current doctor-validation gate result. The npm payload now includes the canonical panel asset and shared helper; the repository CLI and historical launch bridge are not shipped. Current supplied evidence and outstanding checks are recorded in [doctor validation](../../docs/doctor-validation.md).

Historical prototype dependency note (not rerun for doctor validation): after integrating that main revision's pinned Pi 1.4.0 development dependency, npm audit reported three advisories (moderate in `@earendil-works/pi-coding-agent` and `minimatch`, high in transitive `undici`). Package versions/lockfile otherwise match main; no dependency fixes were made.

## API evidence

- [cmux custom-sidebar guide](https://github.com/manaflow-ai/cmux/blob/main/docs/custom-sidebars.md): reactive bindings, context schema and separate agent/lane vocabularies.
- Installed cmux **0.65.2 (113), commit `12023d89f`**: bundled `panel-subagents.js`, `agents-board.js`, `workspaces.js`, `SidebarRuntime.js`; `sidebar`/`right-sidebar` CLI help.
- Source at that commit: `CmuxSidebarActionDispatch.swift` (string-only, fire-and-forget commands), `TerminalController+WorkspaceCreateExecutionPreparation.swift` (`initial_command`), `TerminalController.swift` (`workspace_id` window routing). No cmux source or bundled files are modified.
