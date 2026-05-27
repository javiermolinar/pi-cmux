# Changelog

## [Unreleased]

### Added

- Initial release with the `cmux-notify` extension for cmux-backed pi notifications.
- Added `cmux-v` and `cmux-h` commands to open new cmux splits and start fresh pi sessions in the same working directory.
- Added `/z` and `/zh` via `cmux-zoxide` to open a new split from a zoxide match and start pi in that directory.
- Added `cmux-review` with `/review-v` and `/review-h`, plus bundled `code-review` skill and `/review` / `/review-diff` prompt templates for focused review workflows, including GitHub pull request review via `gh` when given a PR URL.
- Added `cmux-continue` with `/cmcv` and `/cmch` for split-based task handoff in the current checkout or by creating a git worktree branch with `-c <branch>`.
- Added `cmux-open` with `/cmo`, `/cmov`, and `/cmoh` to open a new split and run any shell command there.

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
