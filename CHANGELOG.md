# Changelog

## [Unreleased]

### Added

- Added opt-in tool-start notifications via `pi-cmux.notify.tools` in global or project Pi settings.

### Fixed

- Suppressed `cmux-notify` final-run notifications for detected `pi-subagents` subagents while preserving main-agent final-run notifications and configured tool-start notifications.

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
