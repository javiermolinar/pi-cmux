# pi-cmux

Pi package with [cmux](https://www.cmux.dev)-powered terminal integrations for [Pi](https://pi.dev).

## Why

[Pi](https://pi.dev) works well in the terminal, but terminal-native actions like workspace notifications, editor launching, and pane orchestration are better handled by [cmux](https://www.cmux.dev). This package collects Pi extensions that use the cmux API instead of baking those workflows into Pi itself.

It currently includes cmux-powered notifications, split commands, generic tool launchers, zoxide jumps, review workflows, and split-based task handoff.

## Usage

Install with pi:

```bash
pi install npm:pi-cmux
```

Or with the installer:

```bash
npx pi-cmux
```

If pi is already running, use:

```text
/reload
```

### Feature overview

| Feature | Commands | What it does |
|---|---|---|
| Notifications | automatic via `cmux-notify` | Sends `cmux notify` alerts when Pi waits, completes work, or ends in error/abort. |
| Plain splits | `/cmv`, `/cmh` | Opens a new cmux split and starts a fresh Pi session in the same project. |
| Tool splits | `/cmo <command...>`, `/cmoh <command...>` | Opens a new cmux split and runs any shell command there in the current project directory. |
| Directory jumps | `/cmz <query>`, `/cmzh <query>` | Resolves a zoxide match or direct directory path, then starts Pi in a split there. |
| Continuation handoff | `/cmcv`, `/cmch` | Opens a new split with a related handoff session in the current checkout. |
| Continuation worktree | `/cmcv -c <branch> [--from <ref>] [note]`, `/cmch -c <branch> [--from <ref>] [note]` | Creates a new branch worktree from the current `HEAD` or an explicit base ref, then starts Pi in a split there with handoff context. |
| In-place review prompts | `/review <target>`, `/review-diff [focus-or-pr-url]` | Expands bundled prompts for review in the current pane. |
| Split review sessions | `/cmrv`, `/cmrh`, plus review flags | Opens a review-focused split session for the current diff, a file, a directory, or a GitHub PR URL. |
| Review skill | `/skill:code-review` | Loads the bundled structured review skill for files, directories, diffs, and PRs. |

### Bundled extensions and resources

Extensions:
- `cmux-notify`
- `cmux-split`
- `cmux-open`
- `cmux-zoxide`
- `cmux-review`
- `cmux-continue`

Other bundled resources:
- `code-review` skill
- `/review` prompt template
- `/review-diff` prompt template

### cmux-notify notifications

All notifications use:
- title: `Pi` by default
- subtitle: current run state
- body: a short summary of what pi just did

Set `PI_CMUX_NOTIFY_INCLUDE_RESPONSE=1` to append up to 500 characters of the final assistant response to non-error notifications. This is disabled by default because assistant responses can contain sensitive text. Response text is only appended for final assistant messages that stopped normally or due to length limits; tool-use, error, and aborted turns are ignored.

Current notification types:

- `Waiting`
  - sent when pi finishes a normal run and is waiting for input
  - typical bodies:
    - `Finished and waiting for input`
    - `Reviewed README.md`
    - `Reviewed 3 files`
    - `Searched the codebase`

- `Task Complete`
  - sent when pi finishes a longer run, or when the run changed files
  - typical bodies:
    - `Updated package.json`
    - `Updated 2 files`
    - `Finished in 42s`
    - `Updated 3 files in 1m 12s`

- `Error`
  - sent when the run itself ends in an error or is aborted
  - typical bodies:
    - `read failed for config.json`
    - `edit failed for README.md`
    - `bash command failed`

You can control notification noise with one level setting:
- `PI_CMUX_NOTIFY_LEVEL=all` - `Waiting`, `Task Complete`, and `Error`
- `PI_CMUX_NOTIFY_LEVEL=medium` - `Task Complete` and `Error`
- `PI_CMUX_NOTIFY_LEVEL=low` - `Error` only
- `PI_CMUX_NOTIFY_LEVEL=disabled` - disable cmux notifications

Notification bodies are summarized from the run itself:
- changed files from `edit` and `write`
- reviewed files from `read`
- searches from `grep` and `find`
- shell activity from `bash`
- the final agent error, with the first tool failure used as a fallback summary when needed
- optionally, the final assistant response when `PI_CMUX_NOTIFY_INCLUDE_RESPONSE=1`

### cmux split commands

- `/cmv`
  - opens a new split to the right
  - starts a fresh `pi` session in the same `cwd`

- `/cmh`
  - opens a new split below
  - starts a fresh `pi` session in the same `cwd`

Legacy aliases still available for now:
- `/cmux-v` → `/cmv`
- `/cmux-h` → `/cmh`

Both commands also accept optional initial prompt text. Example:

```text
/cmv Review the auth flow in this repo
```

That launches the new split and starts:

```bash
pi 'Review the auth flow in this repo'
```

in the same project directory.

### cmux generic tool splits

- `/cmo <command...>`
  - opens a new split to the right
  - runs the given shell command in the same `cwd`
- `/cmoh <command...>`
  - opens a new split below
  - runs the given shell command in the same `cwd`

Alias still available for symmetry:
- `/cmov` → `/cmo`

Examples:

```text
/cmo hx
/cmo lazygit
/cmo npm test
/cmoh npm run dev
/cmo watch -n 1 git status --short
```

Commands are executed via `sh -lc` in the current project directory, so multi-word shell commands work as expected.

### cmux zoxide jump

- `/cmz <query>`
  - resolves the query with `zoxide query`
  - opens a new split to the right
  - starts a fresh pi session in the matched directory

- `/cmzh <query>`
  - resolves the query with `zoxide query`
  - opens a new split below
  - starts a fresh pi session in the matched directory

Legacy aliases still available for now:
- `/z` → `/cmz`
- `/zh` → `/cmzh`

Example:

```text
/cmz mono
```

If the argument is already a valid directory path, `/cmz` and `/cmzh` use it directly instead of querying zoxide.

### Continuation and worktree helpers

- `/cmcv`
  - opens a new split to the right
  - creates a related handoff session in the current checkout
- `/cmch`
  - opens a new split below
  - creates a related handoff session in the current checkout
- `/cmcv <note>` / `/cmch <note>`
  - same as above, but adds a focus note to the handoff context
- `/cmcv -c <branch>` / `/cmch -c <branch>`
  - creates a new branch worktree from the current `HEAD`, then opens a new split there
- `/cmcv -c <branch> --from <ref>` / `/cmch -c <branch> --from <ref>`
  - creates a new branch worktree from an explicit base ref such as `main` or `origin/main`
- `/cmcv -c <branch> [--from <ref>] <note...>` / `/cmch -c <branch> [--from <ref>] <note...>`
  - same as above, but also adds a focus note to the worktree handoff

Examples:

```text
/cmcv
/cmcv focus on tests
/cmcv -c fix/notify-bug
/cmcv -c fix/notify-bug --from main
/cmcv -c fix/notify-bug --from main do a review of the existing changes
/cmch -c feature/review-ui focus on edge cases
```

Same-checkout continuation creates a related handoff session and adds an explicit summary of the current context. When the current Pi session is persisted, the new pane also inherits the current conversation path.

Worktree continuation starts a new session in the target worktree and seeds it with a structured handoff summary from the source pane.

### Review helpers

`pi-cmux` also bundles a reusable `code-review` skill plus prompt templates for in-place review:

- `/review <target>`
  - prompt template for reviewing a file, directory, or GitHub pull request URL in the current pane
- `/review-diff [focus-or-pr-url]`
  - prompt template for reviewing the current git diff in the current pane, or a GitHub pull request URL via `gh`
- `code-review`
  - skill used for structured code review of files, directories, and diffs
  - also available directly as `/skill:code-review`

Split review commands:

- `/cmrv`
  - with no arguments, reviews the current git diff in a new right split
- `/cmrh`
  - with no arguments, reviews the current git diff in a new lower split
- `/cmrv [--bugs|--refactor|--tests] <target>` or `/cmrv --diff [focus]`
  - opens a new split to the right
  - starts a fresh pi review session in the same `cwd`
- `/cmrh [--bugs|--refactor|--tests] <target>` or `/cmrh --diff [focus]`
  - opens a new split below
  - starts a fresh pi review session in the same `cwd`

`--diff` is the default, so `/cmrv` and `/cmrh` usually do not need the flag.

Legacy aliases still available for now:
- `/review-v` → `/cmrv`
- `/review-h` → `/cmrh`

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

If the target is a GitHub pull request URL, the review workflow switches to PR review and instructs pi to inspect the pull request with `gh pr view` and `gh pr diff`.

The split review commands start a fresh pi session with a focused bootstrap prompt and instruct pi to use the bundled `code-review` skill when available.

### Environment variables

- `PI_CMUX_NOTIFY_LEVEL` - notification level: `all`, `medium`, `low`, or `disabled` (default: `all`)
- `PI_CMUX_NOTIFY_THRESHOLD_MS` - duration threshold before a run is labeled `Task Complete` instead of `Waiting` (default: `15000`)
- `PI_CMUX_NOTIFY_DEBOUNCE_MS` - minimum delay between duplicate notifications (default: `3000`)
- `PI_CMUX_NOTIFY_TITLE` - notification title override (default: `Pi`)

cmux uses the current `CMUX_WORKSPACE_ID` / `CMUX_SURFACE_ID` automatically, or you can provide those in your environment yourself.
