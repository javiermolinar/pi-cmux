# SSH target contract

One session-scoped runtime separates local Pi context from an explicitly selected remote project. Discovery, workspace labels, saved metadata and navigation IDs never authorize connection. See [user controls](ssh.md).

## Data

`lib/ssh/target.ts` validates and freezes whitelisted values:

| Type | Fields |
|---|---|
| Target | `destination`, absolute POSIX `remoteCwd` |
| Local context | Owning `sessionId`, absolute `localCwd` |
| Optional association | Workspace UUID, explicit backend |
| Persisted target record | Version 1, local owner, resolved target/association, pending destination intent or clear tombstone |
| Separate selection record | `pi-cmux.ssh-tool-selection`: version 1, same local owner, capture/clear marker, bounded guarded membership and exactness (legacy clear-only markers remain readable) |

Destinations accept literal aliases/hosts/IPs and optional user; reject option-like, credential/URI, wildcard, control or shell syntax. IPv6 is validated as an address. Remote paths preserve spaces/quotes/Unicode/dollar signs but reject controls, relative paths and excessive length. Never validate remote paths with local stat/realpath or expand them locally.

Connection requests may omit cwd or supply literal `~`; the connector resolves the remote home before creating an absolute target. Pending records contain only the destination and local owner, never `~` or a placeholder cwd. They restore blocked, without replaying resolution or resurrecting an older target. Older readers reject the new record kind conservatively.

Identity/port/ProxyJump stay in OpenSSH config. No keys, arbitrary SSH options, credentials, readiness or authorization are persisted. Parsers reject getters/non-data objects and discard unknown restoration fields. Action tools separately reject extras.

## State and lifecycle

| State | Meaning |
|---|---|
| inactive | No target; ordinary tools remain local |
| configured | Selected/restored, not validated |
| ready | Current validation permits ticketed remote dispatch |
| disconnected | Failure/stale/invalid intent; no local fallback |
| disabled | Remote dispatch refused; retained intent is not local |

Home resolution revokes dispatch and marks the runtime disconnected with pending intent until an absolute target is available. Its revocation signal fences replacement, including A→B→A, and survives the lookup/caller await boundary through scoped evidence. No unresolved target is dispatched or persisted.

Enabling never activates/reconnects. Clear is explicit, idle-only and persists a target tombstone plus known local membership for durable restoration before another request. Restore reads only the current branch's latest applicable entries; invalid/foreign/local-context-mismatched entries fail closed, not back to an older target. Resume/tree navigation/reload reconstructs configured intent and selection only. Newer persisted local tool choices supersede clear recovery. Shutdown revokes runtime state and latches old selection contexts closed, even if the runtime becomes inactive.

Pi can defer setup-only entries until the first conversation message flushes a session file. Losing unflushed selection never restores authority; no second state file is introduced.

## Runtime API

`SshTargetRuntime` exposes startSession, activate, beginResolution, beginValidation, completeValidation, failValidation, captureDispatch, assertDispatch, observeAssociation, disconnect, clear, setEnabled, shutdown, snapshot and subscribe. Registration is idempotent per ExtensionAPI via WeakMap and wired through the central SSH extension.

Tickets are immutable, runtime-instance capabilities checked by object identity, owner and generation. Replacement—even A→B→A—validation restart/failure, lifecycle/enablement changes and disconnect revoke them. Check synchronously before effects and after awaits. Stale completion/failure cannot affect newer state. Revocation signals request cancellation, not remote quiescence.

Mutations are non-reentrant. Subscribers may inspect/schedule later changes, not synchronously mutate/dispatch. There are at most 32 listeners. Persistence is synchronous; thenables/save failures are rejected and block dispatch.

Associated targets require trusted matching evidence: exact workspace/destination/backend, enabled SSH and connected. Missing/mismatched evidence revokes readiness; it never adopts another host. Native observation and effects are not atomic. Associated placement is currently unsupported by launch/helper integration.

## Locality boundary

- Pi/cwd/credentials/sessions and unrelated extensions stay local.
- Only selected `ssh_read/ssh_write/ssh_edit/ssh_bash` use the ready target, with a separate fresh-turn generation gate. They never execute locally. Core local file/shell/search names keep their owners but are guarded throughout remote intent, including nested calls; [selection rules](ssh.md#tool-selection-and-local-guards) apply.
- Local helpers use local cwd/PATH; remote helpers use a local SSH client and remote cwd/PATH.
- Child selection transfer stays configured-only; origin/messaging IDs are independent.
- Creation is not command success; uncertain effects are never retried automatically.
- Remote-owned layouts, implicit linked-workspace substitution, SSH worktrees/handoffs/zoxide and new previews are unsupported.

This is a trusted in-process API, not a sandbox against extensions controlling Pi/environment.

## Compatibility and evidence

Pinned Pi/minimum peer version: **1.3.0**. cmux **0.65.2 (111)** source was inspected for remote status and create/respawn routing. `remote_context: local` is not a universal backend override. No minimum native cmux version is established for protected creation.

Fixtures cover strict parsing, restoration, persistence, immutable tickets, stale/forged callbacks and association changes. Real Pi 1.3.0/1.4.0 SDK regressions cover both display-equivalent owner load orders, direct/nested/QuickJS dispatch and request/restore boundaries with fake SSH transport. The [current live smoke](ssh-isolation-live-validation.md) separately verifies clean real SSH operations and guard/clear behavior on Pi 1.4.0 in both fixture load orders. Actual pi-tool-display rendering is not verified. [Native evidence](ssh-native-validation.md) is historical ordinary-local-workspace tab evidence; [post-fix core evidence](ssh-postfix-validation.md) covers a historical clean endpoint, not this tool-isolation change. Other layouts, live cancellation and persisted child resume remain unverified.
