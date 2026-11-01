# Historical post-fix SSH core validation

This evidence predates #22's `ssh_read`/`ssh_write`/`ssh_edit`/`ssh_bash` names and selection controller. It is not live verification of the current refactor; old core names below are historical.

On **2026-10-26**, repaired R1/R2 code passed a real core smoke on authorized `javi:/tmp/pi-cmux-smoke.MpOwWVWb`. This used a programmatic host/pinned Pi 1.3.0 definitions, not a live model conversation.

Verified:

- Quiet validation reached ready.
- Framed write/read/edit preserved a special-character filename, Unicode and legitimate notice-like file content; the independent local sentinel stayed unchanged.
- A 58-byte binary payload (NUL/high-bit/CR/LF/Unicode/marker-like data) round-tripped through raw read/MIME cache. Binary editing is not claimed.
- Remote Linux/hostname/cwd/PATH and exit 17 were observed.
- Restore remained configured; refused writes caused neither transport dispatch nor local fallback.
- All 21 protected historical evidence files retained their hashes. No surfaces, existing files, config or prompts were changed; no cleanup/retry/rollback ran.

Retained root:

```text
/var/folders/ql/q2mfmc9j3jz_czh8pjgps42r0000gn/T/pi-cmux-postfix-javi-s0fvG7
```

`report.json` records source hashes, requests and new filenames; `smoke.mjs` is the driver; `protected-before.json` lists preserved artifacts. New files/sentinels/session evidence remain.

Cancellation, noisy stdout, malformed frames and uncertain acknowledgements have deterministic—not live fault-injection—coverage. No new placement, persisted child resume, child remote execution, alias UI or later launch-size guarantee follows. See [historical helper/child evidence](ssh-native-validation.md).
