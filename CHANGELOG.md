# Changelog

## [Unreleased]

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
- Preserve the same `PATH` for `cmux_open_terminal`, `/cmo`, `/cmov`, `/cmoh`, `/cmt`, and configured tool shortcuts, fixing `hunk: command not found` and similar failures in splits and tabs. Launch the inner system shell via `/bin/sh -c`. Correction: cmux's outer login shell can still load profiles before the command restores `PATH` (see Unreleased).

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
