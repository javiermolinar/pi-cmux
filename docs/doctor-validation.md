# Doctor validation

## Verified evidence

- Latest coordinator checks after the F1–F3 fixes passed: **1,473 tests passed, 14 skipped, 0 failed**; `npm run typecheck`, `npm run pack:check` and `git diff --check` passed. Independent review is recorded separately in the plan.

- The original installer reproduced deletion of a pre-existing colliding temporary file. The repaired regression preserves that file and the installed panel. Repository and doctor installation use the same Node-only helper.
- Actual offline `npm pack` fixtures extract the artifact and install/update with only Node built-ins. They verify checksum-based inspection, exact-content replacement, backups, collision preservation and absence of pinned launch configuration. The artifact includes the canonical panel JS and shared helper, not the repository CLI or historical launch bridge.
- The isolated-HOME `npx` installer fixture loads the copied extension through Pi's real loader, exposes only `/cmdoctor` outside verified cmux, and reads the panel asset from the copied package without the checkout. It verifies that the bridge and repository panel CLI were not copied.
- Focused diagnostics/UI/action/context/auto-open checks passed **135 tests** before final package validation. They cover advertised capability discovery, missing methods, executable/socket/authentication failures, nonzero exits, timeouts, stderr and malformed responses; default-off settings precedence; confirmation/cancellation, changed files/paths/sessions, exact non-focusing open and no retries; keyboard navigation, scrolling, width bounds and text fallback without model turns.
- A live **read-only** collection on cmux **0.65.2 (113)** accepted its numeric protocol-version-2 response, found the required method groups advertised, verified the exact local caller, reported `autoOpen=false`, warned about the legacy installed panel, and marked custom-sidebar beta availability unverified. Advertisements do not prove behavior or permissions.
- VHS captures of the real overlay component with synthetic error data were inspected at logical **96×40**, **44×30** and **44×18**. The frame, selected error and bottom actions fit; tests verify detail paging and below-minimum action refusal. Captures are locally at `/tmp/cmdoctor-wide.png`, `/tmp/cmdoctor-narrow.png` and `/tmp/cmdoctor-short.png`, not durable release artifacts.

## Manual visibility follow-up (2026-11-01)

- At the user’s explicit request, selected the already-installed panel with one exact-window/workspace `right-sidebar set custom agent-state-panel --no-focus` call. Native mode inspection returned `visible=true`, `mode=custom-sidebar`; exact caller/focused surface UUIDs remained unchanged. A native screenshot confirmed the agent roster was visible but no Custom tab appeared.
- The installed version’s source (`12023d89f`, `Sources/RightSidebarTabPreferences.swift`) explicitly excludes `.customSidebar` from the mode-tab order, contradicting the authoring guide’s claim that selection adds a Custom button. No cmux source/settings were changed.
- Doctor now has **Show Pi Agents (no focus)** and **Hide right sidebar** actions. Fake-CLI regressions cover exact targets, no installation requirement for Hide, changed/remote/unverified callers, session fences and uncertain failures without retries. Full suite: **1,480 passed, 14 skipped, 0 failed**; typecheck, package dry-run and diff checks passed. The native selection above used the CLI, not the updated doctor buttons; live doctor interaction and native Hide remain unverified.

## Review findings and fixes

The initial independent report (`/tmp/pi-cmux-doctor-review-4a16d2f7.md`) requested changes for decoded-text hashing, omitted workflow dependencies and permission-mode resets. It independently ran the pre-fix suite (1,461 passed, 14 skipped) and does not review the later fixes.

After explicit authorization to fix F1–F3, 11 new regression cases failed against the pre-fix implementation. File identity and managed-body checksums now hash raw buffers, byte changes during confirmation are rejected, and replacements/backups preserve the approved mode even under a restrictive umask. Changes to permissions during confirmation are rejected; fresh installation remains private. The extracted-package test also verifies mode preservation.

Diagnostics now include `system.tree` for origin/switcher navigation, `events.v1` for browser annotation events, and native notification/optional flash advertisements. Legacy `set-status`, `clear-status`, `log`, `set-progress` and `clear-progress` have an explicit unverified CLI-support row instead of guessed RPC mappings or mutating probes. Notification/flash flags remain unexercised by their RPC advertisements. Independent fixed-fixture expectations and missing-advertisement cases guard against the previous self-derived inventory blind spot. Read-only native collection on cmux 0.65.2 advertised the added methods/capability and left the legacy CLI row unverified.

All three fixes have coordinator regression/full-suite verification. **No independent post-fix review has been run; the original review remains incomplete.** Live UI/open/focus limits below are unchanged.

## Reproduce checks

```sh
npm run typecheck
npm test
npm run pack:check
```

`tests/helpers/doctor-preview.mjs` renders synthetic diagnostics using a fixed color adapter. It never accesses cmux, reads settings or installs/opens anything. Run it in a terminal, or capture it with VHS; Tab, arrows, Page Up/Down and Esc exercise the component without effects:

```sh
node tests/helpers/doctor-preview.mjs 96 40
node tests/helpers/doctor-preview.mjs 44 30
node tests/helpers/doctor-preview.mjs 44 18
```

For PNGs, create a VHS tape with the following contents, replacing `/absolute/checkout` and changing logical/pixel dimensions for each case. Run `vhs /path/to/doctor.tape` from a temporary output directory; screenshot paths are relative. Observed pixel sizes were **1200×800**, **600×600** and **600×480**, font size **14**, with logical dimensions supplied separately to the fixture. Pixel size is not a measurement of live Pi geometry.

```text
Set Shell "bash"
Set Width 1200
Set Height 800
Set FontSize 14
Set Theme "Catppuccin Mocha"
Set TypingSpeed 0s
Hide
Type "node /absolute/checkout/tests/helpers/doctor-preview.mjs 96 40"
Enter
Show
Sleep 2s
Screenshot doctor-wide.png
```

The component disables actions below **42 columns × 18 terminal rows**; Esc still closes. Inspect wide/narrow/short captures for clipping, action visibility and selected-detail paging. The active Pi theme adapter is tested separately from the preview's fixed colors.

## Limits

No new production panel was installed in user configuration and no doctor screen or panel-open action was exercised in live Pi during this Run. Action fixtures use real temporary files and fake CLI responses. Headless captures exercise the overlay component, not Pi's overlay lifecycle, current live theme, keyboard routing, confirmation dialogs or native focus.

Live Pi navigation/cancellation, mouse targets, cross-tab/multi-window focus, and all light/dark combinations remain unverified. Historical prototype native evidence in the [panel README](../examples/sidebars/README.md#live-acceptance-checks) is separate; the launch experiment is not a production workflow.

Pi remains **1.3.0+**, Node **22.19.0+**. The Pi 1.3.0 declarations include the temporary-event-unsubscribe API used by doctor; tests use pinned Pi 1.4.0. No broader version matrix or new minimum cmux version is certified. Dependency audit was not rerun. No release, publication, commit or push is part of this Run.

Default `pi-cmux.panel.autoOpen=false` and manual global/project settings are unchanged. Doctor never enables beta, edits settings, installs hooks or configures networking. See [usage and recovery](usage.md#doctor-and-panel-setup).
