# SSH transport and remote-only tools

`registerSshAdapter(pi, options)` returns one shared `SshExecutionAdapter` per Pi API. The bundle registers it without connecting, using Pi 1.3.0 pluggable operations—not the installed example's private state. See [activation and controls](ssh.md).

## Routing

The adapter registers only `ssh_read`, `ssh_write`, `ssh_edit` and `ssh_bash` as direct, inactive-by-default data tools. It never owns or delegates to local `read`, `write`, `edit` or `bash`. `options.enabled: false` (bundle: `PI_CMUX_SSH=0`) disables execution, not registration or saved-intent guards. Enablement is fixed for the loaded adapter.

`lib/ssh/selection.ts` captures branch-local guarded membership before connection effects. Readiness publishes mapped SSH counterparts before Pi snapshots declarations; a separate current-generation fresh-turn gate rejects transition-batch execution, even with a cached tool object. The tools' own execute guards supplement Pi's `tool_call` guard. Direct/nested/codemode calls to local `read/write/edit/bash/powershell/grep/find/ls` are blocked throughout remote intent. Local startup is unchanged. Explicit idle clear restores known, still-available guarded membership and preserves current unrelated membership; reload/resume/tree reconstruction never restores readiness. See [the state matrix and migration rules](ssh.md#tool-selection-and-local-guards).

Configured/disconnected/disabled/pending/invalid SSH intent cannot fall back locally. Each remote workflow also holds an immutable session/generation ticket, checked before effects and after awaits. Replacement, lifecycle changes and disablement revoke tickets.

File paths resolve lexically against remote cwd; closures bypass Pi's local path expansion. No local-prefix, home or environment substitution occurs. Read MIME detection caches at most one bounded file. Write/edit workflows reject overlap; external remote writers are not locked, so edits are not distributed transactions.

Only the four SSH data tools and this adapter's user `!`/`!!` path use SSH. Other tools/extensions, instruction discovery, credentials and output spools remain local. Remote project instructions/extensions are not loaded automatically. Already-admitted local work cannot be cancelled retroactively; earlier competing user-shell handlers and direct extension I/O are outside this boundary.

## Transport

Each request spawns one local `/usr/bin/ssh` without a local shell. Paths/programs are single-quoted; content travels on stdin in 64 KiB chunks with backpressure. The remote needs an account shell, `/bin/bash`, `cat`, `mkdir`, `test` and POSIX `wc`.

OpenSSH retains alias/identity/port/ProxyJump semantics. Enforced options disable interactive passwords, forwarding, control-socket reuse, local-command hooks and SendEnv; host trust must already exist. Config helpers and account startup remain trusted behavior, not a sandbox. The inner bash clears BASH_ENV/ENV and disables profiles/rc files.

The local SSH environment is whitelisted. Remote commands receive neither Mac PATH nor local cwd/session environment. Bash deliberately executes user shell text. Exit statuses are preserved; 255 is conservatively treated as connection/authentication failure.

| Limit | Maximum |
|---|---:|
| Write input | 32 MiB |
| Combined raw stdout/stderr per request | 16 MiB |
| Generated command | 128 KiB |
| Default deadline | 60 seconds |
| Bash deadline cap | 10 minutes |
| Whole file workflow | 60 seconds |

Framing/stderr consume output budget. Oversized files fail; use bounded bash output instead.

## File integrity

Cwd validation requires empty stdout. File replies and the fixed remote-home query have a fresh nonce, canonical decimal byte length, raw payload and exact trailer. Home lookup is capped at 20 KiB of raw output and validates strict UTF-8 plus an absolute path before selection; it never expands a local home. Reads/MIME/edits consume verified bytes only; acknowledgements must have zero payload. Prefixes, suffixes, extra/truncated frames, wrong markers and malformed lengths are rejected, never stripped.

Protocol errors revoke only the current dispatch generation. Invalid mutation acknowledgements mean effects may already have occurred; no retry or rollback follows. Framing uses no remote temporary file or encoding utility. Length counting and payload transfer are separate reads; changing-size files/streams can fail verification. This detects contamination, not malicious-host behavior or concurrent-writer races.

## Validation and cancellation

`resolveHome(destination, signal, assertAuthorized)` revokes prior dispatch and persists destination-only pending intent. It returns an absolute target plus a fence the caller must check immediately before activation, with no intervening await. Failure/reload cannot make pending intent local or restore an older target.

`probeValidation(signal, assertAuthorized)` remains non-ready. Its single-use probe commits synchronously after final cancellation/authority checks; callers must commit or discard. Revoked grants abort pending validation; stale settlement cannot affect a newer ticket.

Associated targets require trusted observation during validation/before operations. Missing/mismatched evidence refuses effects; waits are bounded. Native observation and effects are not atomic.

Cancellation, timeout and output-limit terminate local SSH, escalating after 250 ms. This does not prove remote descendants stopped or effects rolled back. Connection/spawn/timeout failures revoke current readiness; cancellation/output-limit/callback failures do not necessarily do so. Stale failures cannot disconnect a replacement. There is no automatic retry/reconnect.

“Not dispatched” is reserved for definite pre-dispatch failure with no earlier completed stage in that workflow. Cancellation/timeout after a data-stage acknowledgment is uncertain even when the bytes were written successfully; cancellation while awaiting a handed-off connection transport request is conservatively uncertain too. An earlier stage (for example, directory creation before a write) cannot be erased by a later no-dispatch failure. These results warn that remote effects may have occurred and must not be automatically retried. Revoked/stale work still cannot publish success or disconnect a replacement target.

## Evidence

Transport/adapter/protocol/integration tests use injected endpoints, local bash and isolated roots. They cover quoting, binary/Unicode data, noise, malformed frames, cancellation, stale authority and uncertain acknowledgements. Real SDK/QuickJS coexistence and lifecycle tests run on Pi 1.3.0/1.4.0 in both surrogate-owner load orders. The real pi-tool-display package/rendering remains unverified. The [current live smoke](ssh-isolation-live-validation.md) verifies clean real SSH file/shell effects and isolation/clear behavior on Pi 1.4.0 in both fixture load orders, not real-package rendering or production CLI/UI discovery. [Post-fix native evidence](ssh-postfix-validation.md) predates separate SSH tool names. Live noise/cancellation and remote quiescence remain unverified.
