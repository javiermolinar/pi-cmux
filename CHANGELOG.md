# Changelog

## [Unreleased]

## [0.4.1] - 2026-10-30

### Fixed

- Register remote-only `ssh_read`, `ssh_write`, `ssh_edit` and `ssh_bash` instead of claiming core-tool names, allowing local tool extensions to coexist with SSH enabled (#22). Automatically select only counterparts of the prior local selection and guard local file/shell names at direct/nested execution boundaries; `/ssh-clear` restores prior available membership without resetting unrelated tool choices.
- Report cancellation/timeouts after acknowledged SSH effects as uncertain, not “not dispatched”; retain prior workflow-stage effects and warn against automatic retry. Preserve definite pre-dispatch failures and stale-target rejection.
- Declare ready SSH tools before the first fresh model request while retaining the transition-batch execution guard.
- Preserve the restored local tool selection when `/ssh-clear` is followed by exit/resume before another model request. Newer persisted local tool choices take precedence.

### Changed

- Remote integrations must use the `ssh_*` tool names; old core-name transcripts are not reinterpreted or replayed remotely. `PI_CMUX_SSH=0` disables SSH execution rather than resolving tool ownership conflicts. Core-tool renderers such as pi-tool-display do not automatically render the new names.

### Documentation

- Replace exclusive-adapter guidance with the SSH selection/state matrix, disablement and restoration rules, local-extension boundaries and migration limits. Add real Pi 1.3.0/1.4.0 SDK coexistence/QuickJS/lifecycle regressions with a display-equivalent owner in both load orders. Record a bounded [live SSH smoke](docs/ssh-isolation-live-validation.md) on Pi 1.4.0 in both fixture load orders; real-package rendering and live cancellation/fault injection remain unverified.

## [0.4.0] - 2026-10-28

### Added

- `/cm` pane switcher: a transient overlay that lists live cmux terminal and browser tabs, filters as you type by workspace, title, URL or agent, and jumps by revalidated surface UUID. A compact 64-column overlay with explicit workspace headers, two-line tab results, pane/tab locations, theme-colored borders, agent states and shortcut hints makes the hierarchy easier to scan. Agent labels come only from cmux metadata; rows fall back to the surface type. Optional `PI_CMUX_SWITCHER_KEY` adds a Pi-local shortcut (`off` by default). No persistence, sidebar change, pane creation or model turn.

### Changed

- Default Pi placement by task relationship: independent tasks use workspaces; the first active same-task agent/reviewer uses a right split; additional/background collaborators and handoffs use tabs. Explicit placement wins. Reuse existing origin identities and remember up to 64 exact children per creator in memory; expose binding-only child snapshots in launch results without claiming task completion, supervising processes or adding a persistent registry.
- Use project-based naming defaults: new Pi workspaces use the repository/directory name, tabs prefer available task names, and direct/resumed sessions no longer fall back to generic `Pi` when project context exists. Preserve explicit launch titles and `/name`, reuse session names for handoffs, and keep naming separate from appended host instructions. No additional model requests; existing workspaces are not renamed.

### Fixed

- Disable the entire extension bundle quietly outside verified cmux terminals, including inherited/stale surface environments. Check the caller before registering commands, tools, shortcuts or hooks to avoid orientation startup warnings in other terminals.
- Default SSH connections to the remote account's home when cwd is omitted, and accept literal `~` in `ssh_connect` and `/ssh-bind`. Resolve remote `HOME` under bounded framed transport before saving an absolute target; retain pending destination intent so failed or interrupted resolution cannot fall back locally on reload. Invalid explicit paths still require clarification.
- Keep workspace headers visible while scrolling the pane switcher, preserve window and duplicate-workspace disambiguation when filtering, and bound workspace prefixes so long names cannot hide tab titles. Short terminals drop chrome to retain complete results; terminals too small for a result show a resize message and cannot accept an invisible selection.
- Send long launch commands through a private `/bin/sh` script (`lib/launch-command.ts`) so cmux socket requests stay small. This avoids cmux 0.65.2's 4 KiB request-classification bug ([manaflow-ai/cmux#21222](https://github.com/manaflow-ai/cmux/issues/21222)), where a long prompt intermittently failed with `Socket closed before reply` after creating an empty surface. Commands under 1 KiB stay inline, scripts are `0600` and swept after an hour.

### Documentation

- Document the switcher and record its live evidence: cmux 0.65.2 multi-tab jumps in one workspace and exact focus back to the caller. Multi-window/workspace and browser jumps remain fixture-only.

## [0.3.0] - 2026-10-27

### Added

- Experimental SSH execution with explicit target selection, conversational connect, bounded discovery and separately confirmed alias saving. Pi and storage remain local; non-ready remote intent never falls back locally. Resume and child launches restore selection, not readiness.
- Parent startup guard for `cmux_start_pi`: bounded verification of the exact child’s live Pi binding, explicit unconfirmed results and parent UI warnings without model turns or automatic retries. A binding does not confirm task readiness or completion.

### Changed

- Default local Pi launches to minimal PATH: resolve Pi/Node directories and invoke absolute Pi. `PI_CMUX_PI_PATH_MODE=full` preserves caller PATH; both modes propagate.
- Use compact orientation bootstraps and shorter return instructions. Legacy input and persisted entries remain supported; children need updated code. No universal launch-size guarantee.
- Protect bundled Pi tabs/splits and helper creation with local-context RPCs, verified locality and exact UUIDs. Refuse unsupported remote-owned placement without retry. Local sidebar workspaces retain create + respawn.

### Fixed

- Abort revoked SSH grants; commit readiness only under current authority. Frame file replies to reject stdout contamination; malformed mutation acknowledgements remain uncertain without replay. Remote file operations require POSIX `wc`.
- Normalize native UUID case and permit neutral model/thinking startup metadata.
- Distinguish workspace creation from command dispatch on transport failures. Preserve known target refs after creation and report command byte counts without including the launch command.

### Documentation

- Condense usage and SSH references; correct startup naming, login-shell and validation claims. Record the [local startup smoke](docs/startup-smoke.md): one no-prompt workspace and one protected tab passed on cmux 0.65.2 with Pi 1.4.0. SSH evidence remains limited to historical ordinary-local-workspace tabs and post-fix clean core operations; splits, other layouts, long prompts and live fault injection remain unverified.

## [0.2.0] - 2026-10-25

### Added

- Experimental peer messaging with nonblocking send/reply, read-only inbox inspection, and opt-in `cmux_start_pi.returnResults` for automatic findings return. Findings use best-effort follow-ups, not steering, and may incur model usage.
- Topic-first tab titles, shared task markers for related chats, and origin links without copying conversation history.
- `/cmbk` and configurable **Ctrl+Alt+B** to return to the exact originating conversation, including after tab moves.
- `cmux_start_pi.cwd` to start fresh Pi sessions in another directory.
- `PI_CMUX_SIDEBAR_MODE=minimal` for live tokens without package logs/progress, with token opt-out and optional cost display.

### Changed

- Require Pi **1.3.0 or newer**, including the executable on `PATH`.

### Fixed

- Reject stale runtime ownership before scheduling findings, preparing launches, or renaming tabs.
- Recheck pending launch cancellation before creation and child startup; report already-created surfaces without automatic retry or cleanup.
- Preserve full creation UUIDs alongside short refs so automatic return setup can identify the correct child.
- Include `lib/` in local installs so runtime imports resolve.

## [0.1.24] - 2026-09-28

### Changed

- Refresh the README with a terminal-inspired banner, compatibility badges, a capabilities list, quick navigation, and clearer setup instructions around the existing screenshot.
- Notifications are now opt-in: `PI_CMUX_NOTIFY_LEVEL` defaults to `disabled` to avoid duplicating native cmux hook notifications. Set it to `all` to retain the previous default behavior, or choose `medium` or `low` for fewer alerts.

### Added

- Added opt-in conversation tab titles via `PI_CMUX_AUTOTITLE=1` or `pi-cmux.autotitle` in Pi settings. After successful settlement, a cancellable background request through the session model registry names the current cmux tab; no requests run outside interactive cmux sessions. Project settings override global settings, `/name` wins over in-flight requests, and titles persist across reload/resume. Naming sends compact conversation excerpts to the selected provider and may incur additional charges.
- Added title configuration, lifecycle, cancellation, targeting, failure-retry, and transcript-bound regression tests. Reuse Pi's existing model registry API without adding a separate Pi AI dependency.
- Added opt-in tool-start notifications via `pi-cmux.notify.tools` in agent-directory or project Pi settings. Requires an enabled notification level and an interactive cmux surface; project entries can disable global entries. Invalid settings are ignored, and settings reload on session changes.
- Browser opening now automatically adds a compact **Annotate** toggle, initially off. Switching it off restores normal browsing and preserves drafts. Each browser has its own bridge (up to four), with serialized, mandatory confirmation in Pi and deduplicated steering-message dispatch. `/cmba` and `cmux_annotate_browser` remain available for retrying or stopping bridges. Page-side submissions remain untrusted; native Design Mode and unrelated automation are not used or controlled.
- Added annotation lifecycle/protocol tests and a repository-only browser UI fixture with standalone mock and live-overlay modes.

### Fixed

- Final-run and configured tool-start notifications now share an interactive cmux guard (`ctx.mode === "tui"` and `CMUX_SURFACE_ID`/`CMUX_PANEL_ID`). Headless/embedded runs and terminals outside cmux stay silent even when the cmux socket is reachable. `PI_CMUX_NOTIFY_FORCE=1` bypasses this guard, but notifications remain opt-in and still respect `PI_CMUX_NOTIFY_LEVEL`.
- Browser closure now cancels pending annotation approvals and removes stale bindings quietly through a session-scoped cmux event listener. Initial/reconnect inventory checks retry with bounded backoff, and annotation target checks also cover missed events. Malformed surface types remain verification errors rather than removing bindings; other verification failures report their reason instead of claiming drafts remain in a closed page.
- Create sidebar workspaces with `cmux --json workspace create`: cmux 0.64.25's legacy `new-workspace` ignores `--json`, leaving a workspace open without launching Pi. Preserve caller-window targeting, focus, and fail-closed handling without automatic creation retries. Added regression tests and opt-in installed-CLI contract tests against an isolated fake socket.
- Correct the no-login-profile guarantee: cmux 0.64.25 wraps `respawn-pane` commands in `/bin/sh -lc`. The command prefix restores the caller's `PATH`, but cannot prevent login-profile side effects. Launch semantics are unchanged.
- Annotation approval uses a compact note preview and Cancel / Send to Pi, defaulting to Cancel, instead of a full-screen paginated review. Explicit approval, cancellation, target revalidation, and the two-minute deadline remain required. Forged carriage-return and Unicode line-separator payloads are rejected.
- Annotation heartbeat recovery re-arms disconnect detection; container selections omit excerpts containing form controls or editable content.
- Browser opens completing after session-tree navigation no longer restart annotations on the new branch. Late open continuations after shutdown or session replacement cannot restart lifecycle listeners.

## [0.1.23] - 2026-09-28

### Added

- Added `/cmb [--down] [--focus] <url>` and `cmux_open_browser` for explicitly requested browser splits, targeting the calling Pi terminal and keeping focus in Pi by default.
- Added runtime-only browser/session bindings, bounded and cancellable cmux calls, strict target validation, and regression tests. Lifecycle cleanup leaves browser panes open. This stage provides opening only, without annotations, a steering bridge, or browser interaction tools.

## [0.1.22] - 2026-09-27

### Removed

- Removed `/cmrv`, `/cmrh`, `/review-v`, and `/review-h` and the built-in review prompts and skill. Review using a regular Pi chat or split with your preferred tooling; former command names are available for configured shortcuts.

## [0.1.21] - 2026-09-27

### Added

- Added `/cmn <prompt>` to start a fresh Pi chat in a task-named workspace in the left sidebar, without flags.
- Added the agent-facing `cmux_start_pi` tool for user-requested fresh chats and handoffs, defaulting to sidebar workspaces with optional split/tab placement, model settings, titles, background opening, and new-worktree handoffs. Existing split shortcuts remain unchanged.
- Target new workspaces through the caller's window and returned workspace/surface IDs, rejecting ambiguous discovery instead of launching in the selected terminal.
- Added workspace, command, tool-registration, and handoff regression tests using stubbed cmux calls and the installed Pi session manager and CLI parser.

### Fixed

- Persist summary-only and user-only handoff sessions before launching Pi, preserving context that Pi otherwise defers writing until the first assistant response.
- Exclude the executing tool-call batch from agent-requested handoffs so new sessions do not inherit unfinished calls.

## [0.1.20] - 2026-09-08

### Fixed

- Associate sidebar status with its cmux surface and Pi process so cmux can remove stale status after an exit.
- Keep delayed, shutdown, and startup status cleanup targeting the owning surface after it moves to another workspace.

## [0.1.19] - 2026-09-07

### Fixed

- Preserve the calling Pi process's `PATH` when launching new Pi sessions, fixing `pi: not found` when cmux's terminal environment cannot find Pi or Node.
- Preserve the same `PATH` for `cmux_open_terminal`, `/cmo`, `/cmov`, `/cmoh`, `/cmt`, and configured tool shortcuts, fixing `hunk: command not found` and similar failures in splits and tabs. Launch the inner system shell via `/bin/sh -c`. Correction: cmux's outer login shell can still load profiles before the command restores `PATH` (see 0.1.24).

## [0.1.18] - 2026-09-07

### Changed

- Require Pi 0.85.1 or newer and Node.js 22.19.0 or newer; update the pinned development Pi dependency and lockfile.
- Support quoted provider, model, and thinking options, including `max`, in the shared Pi command builder.

### Fixed

- Use cmux's returned surface IDs when opening splits and tabs to avoid respawning or renaming another terminal during concurrent creation. Retain bounded discovery for older cmux responses and reject ambiguous matches.
- Delay notifications, final sidebar states, logs, and flashes until Pi fully settles, avoiding premature completion during automatic retries, compaction, and queued follow-ups.
- Stop option parsing before initial prompts so dash-prefixed text is not interpreted as Pi CLI flags.

### Added

- Added shell-quoting and installed Pi parser regression tests, with CI coverage on Node.js 22.19.0 and 24.
- Added surface-targeting regression tests for direct IDs, concurrent launches, and legacy discovery failures.
- Added weekly Dependabot pull requests for Pi dependency updates.

## [0.1.16] - 2026-05-27

### Added

- Added `/cmt` to open a shell command in a new cmux tab.
- Added an agent-facing `cmux_open_terminal` tool so Pi can open explicitly requested interactive terminal commands in cmux splits or tabs.

## [0.1.15] - 2026-05-27

### Added

- Added pluggable cmux split commands via `pi-cmux.commands` in Pi settings, with shorthand entries, argument forwarding, configurable split direction, and project-local overrides.

### Changed

- Documented tool workflows as generic/pluggable commands instead of app-specific shortcuts.

## [0.1.14] - 2026-05-27

### Fixed

- Reset stale tool status after tool execution ends so failed bash/tool calls do not leave `Pi bash` pinned while Pi continues thinking.

## [0.1.13] - 2026-05-27

### Added

- Added compact live cumulative session token counts to cmux sidebar progress/final summaries, with optional reported cost via `PI_CMUX_SIDEBAR_COST=1`.

### Changed

- Split cached input out from normal input in sidebar token summaries.

### Fixed

- Count provider-reported token usage/cost from aborted or errored assistant messages in sidebar token totals.
- Show aborted Pi runs as cancelled/warning in the cmux sidebar instead of red `Pi error`.
- Stopped leaving persistent `Pi idle` / `Pi done` status pills in the cmux sidebar after runs finish.

## [0.1.12] - 2026-05-27

### Added

- Renamed cmux tabs/surfaces spawned by split, tool, zoxide, continuation, and review commands with `<title> · <repo-or-dir>` contextual titles.

### Changed

- Updated split review prompts to use `code-review` only when another package provides it.

### Removed

- Stopped shipping the generic `code-review` skill and `/review` / `/review-diff` prompts to avoid conflicts with other Pi packages.

## [0.1.11] - 2026-05-27

### Added

- Added `cmux-sidebar` to update cmux sidebar status, progress, logs, and flash indicators during Pi runs.

### Changed

- Condensed the README and moved detailed command examples to `docs/usage.md`.
- Hardened CI with `npm ci`, a committed lockfile, pinned development dependencies, and reusable npm scripts.

### Fixed

- Prevented sidebar progress-clear timers from keeping one-shot Pi runs alive.
- Kept sidebar cleanup commands running after optional cmux command failures such as unsupported `trigger-flash`.

## [0.1.10 and earlier]

### Added

- Initial release with the `cmux-notify` extension for cmux-backed pi notifications.
- Added `cmux-v` and `cmux-h` commands to open new cmux splits and start fresh pi sessions in the same working directory.
- Added `/z` and `/zh` via `cmux-zoxide` to open a new split from a zoxide match and start pi in that directory.
- Added `cmux-review` with `/review-v` and `/review-h`, plus bundled `code-review` skill and `/review` / `/review-diff` prompt templates for focused review workflows, including GitHub pull request review via `gh` when given a PR URL.
- Added `cmux-continue` with `/cmcv` and `/cmch` for split-based task handoff in the current checkout or by creating a git worktree branch with `-c <branch>`.
- Added `cmux-open` with `/cmo`, `/cmov`, and `/cmoh` to open a new split and run any shell command there.
- Added optional localized copy for `/cmo`, `/cmov`, and `/cmoh` when a Pi i18n provider is present.

### Changed

- Documented the current cmux notification types and removed the debug/test step from the README.
- Added shorter command names for cmux workflows: `/cmv`, `/cmh`, `/cmz`, `/cmzh`, `/cmrv`, and `/cmrh`, while keeping the previous command names as aliases for now.
- Made `/cmrv` and `/cmrh` default to reviewing the current git diff when run without arguments.
- Extended `/cmcv -c` and `/cmch -c` to support `--from <ref>` / `-f <ref>` when creating a new worktree branch.
- Added `PI_CMUX_NOTIFY_LEVEL=all|medium|low|disabled` so notification verbosity can be configured with one opinionated setting.
- Added `PI_CMUX_NOTIFY_INCLUDE_RESPONSE=1` to optionally append the final assistant response to non-error notifications.

### Fixed

- Adjusted `cmux-notify` so the notification only shows `Error` when the run itself ends in an error or abort, instead of surfacing handled intermediate tool failures as final errors.
- Updated `npx pi-cmux` installs to install `pi-cmux` as a local Pi package under `~/.pi/agent/packages/` and register it in `settings.json`, so bundled `extensions/`, `skills/`, and `prompts/` all load correctly.
- Added an `extensions/index.ts` bundle entry and pointed the package manifest at it so package installs use a single extension entrypoint instead of trying to import the `extensions/` directory directly.
- Adjusted `cmux-continue` prompts so summary-only same-checkout handoffs no longer claim inherited session history, and worktree continuation no longer duplicates the same handoff summary in both the seeded session and bootstrap prompt.

### Removed

- Removed the `cmux-notify-test` command from `cmux-notify`.
