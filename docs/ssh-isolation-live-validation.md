# SSH isolation live validation

On **2026-10-30**, a user-authorized smoke passed against `javi:/tmp/pi-cmux-smoke-6Q73PJ6e` using current source and real OpenSSH transport. The new remote directory, its four files and local fixture roots were retained. This evidence is not permission to reuse or remove them.

## Scope and environment

- Node **26.12.1**, real Pi **1.4.0** SDK sessions, local Darwin host; remote `debian`/Linux.
- Both extension factory load orders, with a display-equivalent fixture owning local `read`, `write`, `edit` and `bash`; SSH enabled by default.
- Current package adapter/selection/connection code, existing noninteractive SSH authentication and host trust. Thirty transport requests settled without retries; two intentional command exits preserved status 17.
- No model/provider requests, cmux effects, panes/child agents, SSH config changes, running-session reload or cleanup.

This uses programmatic factory loading and manual model-turn lifecycle events, **not** an end-to-end CLI/Jiti or real pi-tool-display rendering test. Tool constructors resolve from the repository's pinned Pi 1.3.0; session/runner/QuickJS use 1.4.0. Disposable SDK sessions use in-memory storage, so this is not persisted resume evidence.

## Observed results

Both load orders passed:

1. Local core definitions retain their fixture owner; ordinary local writes work before connecting.
2. Successful explicit connection selects SSH counterparts. Transition-batch data calls reject until a fresh turn.
3. Stale direct, nested and deferred local calls reject with no local or remote dispatch.
4. Real `ssh_write`, `ssh_read` and nested `ssh_edit` preserve a filename containing spaces, a quote, literal `$HOME` and Unicode. An independent `ssh_bash` read verifies exact edited bytes.
5. Actual QuickJS codemode runs `ssh_bash`; its shell sentinel exists remotely, not locally. Remote hostname/cwd/PATH and exit 17 are observed.
6. Core owner identities and both local sentinel SHA-256 values remain unchanged.
7. Idle `/ssh-clear` restores the exact prior loadout. Cached SSH calls then reject without transport, while local read works again.

## Evidence identifiers

The retained local report is:

```text
/var/folders/ql/q2mfmc9j3jz_czh8pjgps42r0000gn/T/pi-cmux-live-isolation-javi-RY50hz/report.json
```

It records source hashes, SDK session IDs, local fixture paths, remote filenames, request outcomes and before/after sentinel hashes. Task-local driver/report copies are `plans/ssh-tool-isolation-live-smoke.mjs` and `plans/ssh-live-javi-smoke-r32.report.json`; these private coordinator artifacts are not included in the npm package.

Code identifiers at the smoke boundary:

- `lib/ssh/adapter.ts`: `e08f6d7514733cdeda10d03be31df4dcb62612d717f34856ae895f3d4a8f18b3`
- `lib/ssh/selection.ts`: `2a1e5b1c31011f879f0a78ae027de5dbb91b739ca7d1b173794203b0ebda15ba`

All eleven recorded source/driver hashes and both retained local sentinel hashes matched after the run. SDK sessions were disposed; the coordinator's loaded runtime was not changed.

## Not established

Actual pi-tool-display rendering, production CLI/UI/RPC composition, live cancellation/noisy-account fault injection, remote quiescence, default-home resolution, persisted resume, helper/child/layout behavior and live child remote execution. The cancellation fix has deterministic SDK regressions, not live timing fault injection. Independent post-fix review sign-off remains open.
