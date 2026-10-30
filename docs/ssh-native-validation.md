# Historical native SSH validation

Authorized on **2026-10-25–26** for `javi:/tmp/pi-cmux-smoke.MpOwWVWb`, using an ordinary local cmux workspace. Files/surfaces were retained: no deletion, existing-prompt input, reload, alias/config writes or other-host probes.

This predates the R1/R2 repairs, later launch-size changes and #22 separate SSH-tool/selection refactor. References to core tools below describe the old implementation, not current names or validated current behavior. See [post-fix core evidence](ssh-postfix-validation.md); neither smoke certifies later native child launches.

## Environment and results

- Base commit `9afddf853004f935f9ad6b5852b3eb9ea8e5c233` plus uncommitted feature.
- cmux **0.65.2 (111)**, `9d01f956c`; actual child Pi **1.4.0**, product tool definitions pinned to **1.3.0**.
- Local Darwin/`javimolinas-MacBook-Pro.local`; remote Linux/`debian`, PATH `/usr/local/bin:/usr/bin:/bin:/usr/games`.

Observed:

1. Real authentication/cwd validation through a programmatic host, not live model conversation.
2. Core write/read/edit on a space/quote/dollar/substitution/Unicode filename; independent local sentinel unchanged; remote exit 17 preserved.
3. Restore configured-only; remote-intended write refused without local fallback.
4. Remote/local helper tabs showed independent hostname/cwd/PATH markers on exact returned surface UUIDs.
5. Real offline local Pi tab started with configured-only target, distinct session ID, local session filename and consumed bootstrap. No initial prompt/model call. `sessionFileExists=false`: startup evidence, not persisted resume.

Initial probes exposed missing UUID output/case normalization and rejection of neutral model/thinking startup entries. Corrections passed fixtures, then a new child launch. Failed surfaces were retained, not automatically retried. Final historical suite: 905 pass/13 skip; 11 isolated CLI contracts. All 14 protected native files retained their hashes.

## Retained evidence

Root:

```text
/private/var/folders/ql/q2mfmc9j3jz_czh8pjgps42r0000gn/T/pi-cmux-live-javi-q13BGT
```

Reports: `report.json` (initial refusal), `report-uuid-format.json` (helpers), `report-child-native.json` (initial child refusal), `report-child-native-2.json` and `child-native-proof-2.json` (corrected startup). Matching drivers/observer/local launcher are retained there.

| Surface | UUID |
|---|---|
| Remote helper | `85EDBCD4-CABF-481A-B5DA-ED3D432AC65C` |
| Local helper | `0F311198-CBF4-49C1-B592-0E5382B504FA` |
| Failed child | `DF4FC3C5-D6F0-4C88-BBA6-F04EB68BBF50` |
| Corrected child | `137B2D9A-B27D-4A1E-A358-C56ADA506107` |

These identities are evidence, not permission to interact with resources.

## Not established

Right/down splits, remote-owned layouts, related-origin navigation, persisted child resume/remote execution, model-language behavior, alias UI, live cancellation/noisy accounts, rollback or browser routing. No minimum native cmux version is inferred. Local SSH termination does not prove remote quiescence. Independent review remains separate.
