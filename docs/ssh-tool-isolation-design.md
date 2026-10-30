# SSH-specific tools: isolation and lifecycle contract

Contract for issue [#22](https://github.com/javiermolinar/pi-cmux/issues/22), initially written in step 01 and now implemented in the uncommitted adapter/selection controller. The core-override workaround has been replaced, not retained underneath. This is a design/evidence reference, not independent acceptance or live-package certification; see [user behavior and limits](ssh.md).

This design was amended after interim findings F1/F2: actual request-boundary and file-backed resume regressions require early declaration membership (separate from execution admission) and durable clear membership. The original independent report is preserved; passing these regressions is not an independent review outcome.

## Decision and scope

Never register `read`, `write`, `edit` or `bash` from pi-cmux. Register remote-only `ssh_read`, `ssh_write`, `ssh_edit` and `ssh_bash`; keep the existing SSH transport, literal-path rules, limits, mutation serialization and generation tickets. Other extensions retain ownership of local tools regardless of load order or SSH enablement. Startup must not connect, discover targets, scan SSH config, or change an ordinary local session's selected tools.

This is one coherent refactor, so no handover checkpoint is needed. Registration and lifecycle implementation are sequential because they share the adapter/runtime contract. Runtime refactoring, production regression tests, user-documentation migration and independent review are separate plan steps; this note does not authorize any of them.

## Verified Pi API behavior

The repository pins Pi **1.3.0**. The same research probes passed against the installed **1.4.0**. No minimum-version increase is needed for these APIs.

| API or behavior | Observed contract in both versions | Design consequence |
|---|---|---|
| `registerTool` | Registers an owned tool; repeated registration by the same extension replaces its definition. Core-name conflicts across extensions are detected by the resource loader. No `unregisterTool` API exists. | Use separate names, not delayed core overrides or attempted ownership transfer. |
| `exposure: "direct", defaultActive: false` | Registered but not automatically active or nested-callable. Explicit settings/allowlists or `setActiveTools` can still activate it. | Register SSH data tools this way, then reconcile restored/explicit activation at session startup. Their execute methods must also reject local/non-ready state. |
| `exposure: "model-only"` | Active tools are declared to the model but never callable through `ctx.executeTool`, including codemode. | Use for `ssh_connect`, with `executionMode: "sequential"`. Connection transitions must not be nested in scripts. |
| `codemode` / `deferred` exposure | Tools remain nested-callable while inactive. | Do not use these exposures for SSH data tools. A local counterpart supplied with these exposures still needs an execution guard. |
| `hidden` exposure | Registered but not activatable/callable. | Available if necessary, but repeated re-registration is not required for the ordinary SSH data-tool lifecycle. |
| `pi.getActiveTools()` / `setActiveTools()` | Names declared to the model; setting them updates session tools. Unknown, filtered and hidden names cannot be activated. | Change selected names, never local definitions. Respect `--tools`, exclusions and extension-provided exposure. |
| `prepareLoadout.hiddenDeclarations` | Removes declarations from provider presentation without deactivating tools or removing nested reachability. Codemode's `only` mode uses this. | Prompt hiding is not an execution boundary. |
| `tool_call` | Runs for model and `ctx.executeTool` calls; nested calls include `parentToolCallId`. Returning `block` or throwing prevents that call's normal execution. | Install one state-based local-tool guard, regardless of SSH enablement. |
| `ctx.tools` / `ctx.executeTool` | The context getter sees current callable tools. Each nested call goes through argument validation and tool hooks. | Removing active direct tools removes ordinary nested reachability; the guard covers other exposures and reactivation. |
| Codemode | Takes a callable-tool snapshot for each script's `tools`/`ALL_TOOLS`; actual calls go through `ctx.executeTool` again. | A cached script declaration is not permission to execute a stale local call. |
| `user_bash` | Undefined passes to later handlers/local fallback; a handler error prevents normal fallback. The first returned result/operations handles the command. | Retain remote operations in ready state and explicit refusal in non-ready remote state. |
| Lifecycle | Initial active tools can be restored from transcript before `session_start`; tree navigation restores tools before `session_tree`; reload emits shutdown, invalidates the runner, rebuilds tools and emits startup when host bindings are attached. | Reconcile on each lifecycle boundary, not only at initial factory registration. Never carry readiness into the new lifecycle. |

SDK research used isolated temporary directories, in-memory settings/session storage, disabled model-network refresh and fake tool implementations. It made no model requests, SSH connections or cmux calls. Reproducible probe and results are retained as task-local artifacts:

```sh
node plans/ssh-tool-isolation-api-probe.mjs node_modules/@earendil-works/pi-coding-agent
node plans/ssh-tool-isolation-api-probe.mjs /Users/javimolina/.pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-coding-agent
```

Results: `plans/ssh-tool-isolation-api-1.3.0.json` and `plans/ssh-tool-isolation-api-1.4.0.json`. Both passed actual QuickJS discovery/call probes, stale direct/nested-call blocking, guard-error behavior, active-tool restoration, model-only exclusion, and reload ordering. These were step-01 API feasibility checks, not validation of the then-unimplemented SSH lifecycle. Later runtime/regression evidence is summarized below.

Relevant implementation references in each installed Pi package:

- `dist/core/resource-loader.js`: `detectExtensionConflicts`.
- `dist/core/agent-session.js`: `_getCallableTools`, `_applyToolLoadout`, `_refreshToolRegistry`, `_beforeToolCall`, `_executeNestedToolCall`, `_restoreToolsFromTranscript`, `reload`, and tree navigation.
- `dist/core/extensions/runner.js`: `createToolContext`, `emitToolCall`, `emitUserBash`.
- `dist/core/nested-tool-calls.js`: `NestedToolCallRunner.execute` (identical in 1.3.0 and 1.4.0).
- `dist/extensions/codemode/execute.js`: per-script callable snapshot and nested execution.
- The sibling `pi-agent-core/dist/agent-loop.js`: top-level sequential batch handling and preparation before execution.

## Guarded local tools and available remote operations

Guard these exact local names whenever they are registered: `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find`, `ls`. The additional search/list/shell tools otherwise operate on the local project and can mislead the agent in an SSH-intended session. Do not register, rename or wrap their owners' definitions.

There are four remote counterparts: `read → ssh_read`, `write → ssh_write`, `edit → ssh_edit`, `bash → ssh_bash`. Do not invent `ssh_grep`, `ssh_find`, `ssh_ls` or a remote PowerShell implementation in this change. Remote search/list operations may use an already selected `ssh_bash`, with the existing shell/transport limits. Do not silently add it when the user omitted shell access from the local selection.

Map the saved selected local counterparts, not every registered local tool. By default all four are selected; a read-only/custom local selection must not automatically enable remote writes. Names filtered out by Pi's configured allow/deny lists remain unavailable. If required mapped SSH names cannot be activated, report the configuration conflict and keep file/shell operations blocked rather than re-enabling locals or bypassing Pi's filters.

Unrelated tools remain unchanged. MCP tools, helper tools, custom filesystem aliases, direct JavaScript filesystem access from extensions and arbitrary third-party tools are not automatically remote or sandboxed. Existing cmux helpers retain their own explicit target/locality checks. Pi's extension process and session/output storage remain local.

## State matrix

“Block locals” means both remove guarded local names from the active selection and reject them in `tool_call`, even if another extension reactivates them or uses an always-callable exposure. “SSH selected” means only the available counterparts derived from the saved local membership. The SSH tools' own execute methods always require a current dispatch ticket.

| Runtime/phase | Local counterparts | SSH data tools | `!` / `!!` behavior | Recovery |
|---|---|---|---|---|
| `inactive` | Preserve current selection/definitions | Inactive; forced/stale execution rejects | Pass through to normal local behavior | Explicit connect |
| `disabled`, no target/reason | Preserve current selection/definitions | Inactive; execution rejects | Normal local behavior | Enablement requires restart/reload |
| Resolving home / connecting | Block locals | Inactive; execution rejects | Refuse local fallback | Complete the authorized connection, fresh retry, or explicit clear |
| `configured` (selected or restored) | Block locals | Inactive; execution rejects | Refuse local fallback | Explicit validation/connect or clear |
| `ready`, waiting for a fresh model turn | Block locals | Mapped names are selected before the next request snapshot; data calls in the transition batch still reject | Remote operations may use the valid ticket | Next model turn, or explicit clear |
| `ready`, current generation and model turn | Block locals | Select mapped counterparts; enforce dispatch tickets | Remote operations | Explicit clear or target replacement |
| `disconnected`, pending or invalid saved intent | Block locals | Inactive; execution rejects | Refuse local fallback | Fresh authorized connection/validation or clear |
| `disabled` with target/reason | Block locals | Inactive; execution rejects | Refuse local fallback | Explicit clear, or enable and explicitly validate |
| Shutdown / session replacement | Revoke generation and reject stale contexts; discard in-memory selection state | No old-generation dispatch | No stale dispatch | Reconstruct the new branch before its next run |

“Connecting” is a phase, not a required new persisted runtime state. The existing home lookup represents it as `disconnected` with `connection-pending`; an absolute-path connect selects `configured` synchronously before awaiting validation. The action must establish remote intent and capture the local selection before any transport await. A text clarification, discovery suggestion or saved approval is not itself a connection action.

## Selection capture, persistence and restoration

1. At the first authorized local-to-remote transition, capture which guarded local names are active. Do not recapture an already filtered remote loadout on retry, revalidation or target replacement.
2. Persist that bounded membership in a versioned, branch-local custom entry named `pi-cmux.ssh-tool-selection`, associated with the owning session ID and exact local cwd. The entry stores only whitelisted local tool names and a capture/clear marker, never executable definitions, exposure overrides, credentials or readiness. New clear records include the known restored local membership and exactness; legacy clear-only tombstones remain readable. Persist before target effects; save failure blocks the transition.
3. Keep the selection entry separate from the existing version-1 SSH target record; do not silently change its strict schema or the child launch envelope. A selection record without remote target/pending intent is inert. A clear target tombstone invalidates an older selection episode. Restoring a branch uses only that branch's applicable records, not abandoned branch history.
4. On connect/pending/disconnect, remove the guarded locals and owned SSH data names from the selected set. On readiness, add only the mapped available SSH counterparts before Pi captures the next request’s declarations. Separately gate their execution until the fresh model turn; declaration membership is not execution admission. Leave unrelated current tool names in place.
5. On explicit `/ssh-clear`, revoke dispatch, persist the target clear marker and save the known restored membership in the selection-clear record before restoring tools. Remove owned SSH names, then restore the saved local membership that is still registered, activatable and permitted by Pi. Preserve the current selection of unrelated tools rather than replacing the whole loadout with a stale snapshot. Managed local membership returns to its pre-SSH value; changes to unrelated tools made during SSH survive.
6. For new-format resume/reload/tree navigation, use the saved capture instead of the already-filtered transcript. In local mode after clear, replay the known clear membership only when no newer persisted system-tool delta supersedes it; unrelated prompt-only messages do not supersede it. This closes the clear→exit window without overriding later persisted user selections. For an old session without a capture, retain only guarded membership actually present in its reconstructed pre-filter loadout; do not infer missing tools or enable default write/shell access. If capture metadata is invalid or unavailable, keep the remote session fail-closed; explicit clear can remove remote intent but must warn when exact local selection restoration is impossible and leave unknown/missing local membership disabled until explicitly selected.
7. Fresh child sessions capture their own initialized local selection before accepting configured-only SSH intent. Do not copy the parent's loadout or readiness. New session/foreign cwd/foreign records cannot reuse another context's capture.

Use existing session entries, not a new global settings file, host registry or tool-definition persistence. A capture and target save are separate writes, not a multi-file transaction: restoration must treat orphaned or invalid records conservatively. No startup rewrite of local definitions is needed.

## Concurrency and stale calls

### Model-only connection changes

Keep `ssh_connect` sequential and make it `model-only`. Pi's top-level loop serializes the entire response batch when a top-level tool is sequential. In contrast, the nested-call runner queues only calls it classifies as exclusive; a nonsequential sibling can overlap a sequential nested call. The probe reproduced that overlap in both versions. Merely keeping the current sequential flag would not establish a barrier inside codemode's `Promise.all`.

Consequently, scripts cannot connect, replace a target or revalidate through `ssh_connect`; the model uses the direct tool. `/ssh-bind` and `/ssh-validate` already require idle execution; `/ssh-clear` must receive the same idle restriction. Trusted in-process callers of the exported runtime remain outside the safety boundary.

### New generation needs a fresh model turn

After connection or target replacement commits readiness, do not admit remote data calls from the already generated response batch. Pi may retain a prepared tool object/list from that batch; a following `ssh_write` must not silently use a newly selected host. Mark the new generation as awaiting a fresh turn and release data-tool admission at the next `turn_start`. New model-visible selection/prompt state must describe the target before data operations run. A valid ready ticket alone is not sufficient for this transition-batch rule.

An idle command connection uses the same rule: readiness selects its mapped data tools before the request snapshot, and the next model turn releases their execution gate. Existing user-shell operations have an explicit runtime target and retain their own ticket checks. Reject and explain stale data calls; never rewrite a local tool call into an SSH call or retry it automatically.

### Execution boundaries and limits

- The local `tool_call` guard is required even for deactivated tools: top-level batches may retain old tool objects, codemode can cache declarations, and third-party local tools can have deferred/codemode exposure.
- Every SSH execute captures a current generation/session/cwd ticket and checks it before effects and after relevant awaits. Revocation remains monotonic, including A→B→A replacements.
- Pi awaits extension hook chains. A hook is not an atomic lock covering arbitrary later handlers or an extension's own direct filesystem operations. Model-only transition controls and idle-only commands avoid the supported connection/clear paths racing those admitted local calls; do not describe this as a sandbox against arbitrary extensions.
- Local operations already admitted or running before a connection action are not retroactively cancelled. A connection later in a sequential response cannot undo an earlier local effect. Queued calls reaching the guard after intent changes are refused; already admitted work and unobserved remote descendants require explicit limitations, not claims of quiescence.
- First-handler-wins `user_bash` composition cannot force an earlier third-party shell handler to route remotely. Retain our own no-fallback hook and document the limit for competing shell adapters; the core-tool-display conflict does not require accepting arbitrary shell adapters.

## Lifecycle integration points

- Preserve central order: target restoration, one-shot child bootstrap, then other startup/orientation entries. A newly persisted selection capture must not cause the existing fresh-bootstrap check to reject an otherwise valid child: capture after the bootstrap's branch eligibility check, or after configured selection is accepted but before any await/dispatch. Do not weaken that check to accept arbitrary history.
- `session_start` and `session_tree` reconstruct target, branch capture and tool selection synchronously before dispatch. Restored targets are configured, never ready. `before_agent_start` reconciles later external changes and supplies SSH-specific guidance; it must not reconnect or replace the whole system prompt.
- `turn_start` releases only the current ready generation's fresh-turn data gate, never a previously revoked generation.
- The runtime's `subscribe` callback may synchronously inspect snapshots and update Pi's selected tools. It must not recursively mutate the runtime or capture a dispatch ticket while the runtime mutation guard is held. Subscribe before accepting target changes; never rely on observers swallowing errors as successful synchronization.
- Shutdown revokes runtime tickets, pending actions and turn-admission state. The controller must latch the old lifecycle closed: `runtime.shutdown()` clearing its target back to inactive is not permission for local tool calls during teardown. Require a live matching session/cwd context even in local mode, and reopen admission only after the next matching startup reconstruction. Old callback closures remain invalid; no late result may restore tools or readiness in the replacement session.
- Keep helper/child transport contracts unchanged: exact target tickets, configured-only child selection, locality guards, no unsupported SSH handoffs/worktrees/browser previews.

## Original implementation and migration inventory

The table records the pre-refactor assumptions and intended changes, not claims about today's file contents.

| Files | Assumptions to replace or preserve |
|---|---|
| `lib/ssh/adapter.ts` | Core registrations and inactive local delegation become SSH-only definitions; prompt text names SSH tools; add mode/selection/turn guards without weakening tickets, literal paths or mutation rules. |
| `extensions/cmux-ssh.ts` | Registration/enablement wiring, lifecycle ordering and current-request grants; replace the workaround rather than retaining ownership branches. |
| `lib/ssh/connect.ts` | Core-routing wording and nested-callable connection registration; use model-only sequential control and the transition capture/admission contract. |
| `lib/ssh/runtime.ts`, `target.ts` | Preserve generation, pending intent and strict restoration contracts; integrate branch selection capture without silently expanding the target schema. |
| `lib/ssh/launch.ts` | Preserve one-shot bootstrap eligibility and configured-only authority; coordinate capture ordering for fresh children. |
| `tests/cmux-ssh-adapter.test.mjs` | Harness expects four registered core tools and local delegation; separate unchanged local owners from SSH tool execution. |
| `tests/cmux-ssh-integration.test.mjs` | Local and remote writes/reads/edits/bash use identical names; rewrite remote expectations and model actual selection, nested calls and lifecycle. Preserve sentinels and disable/restore checks. |
| `tests/cmux-ssh-review-fixes.test.mjs` | Framed edit scenarios call `edit`; migrate to `ssh_edit` without weakening noise/uncertainty tests. |
| `tests/cmux-ssh-registration.test.mjs` | Workaround expects default-enabled ownership of core tools and coexistence only when disabled; replace with no core ownership in every mode and both load orders. |
| `tests/cmux-ssh-connect.test.mjs`, `cmux-ssh-launch.test.mjs`, `cmux-ssh-native-bootstrap.test.mjs` | Retain authority/bootstrap behavior; add control exposure, fresh-branch capture ordering and new selection-entry coverage. |
| New focused selection/API integration tests | Full state matrix, filtered/custom selections, corrupt/missing/legacy captures, deferred local owners, real codemode, direct sequential and nested-race rejection, fresh-turn target replacement. |
| `README.md`, `CHANGELOG.md`, `docs/ssh.md`, `ssh-adapter.md`, `ssh-connect.md`, `ssh-target-contract.md`, `ssh-smoke.md` | Current guidance calls the standard core tools remote or requires exclusive ownership; migrate terminology, disablement, selection restoration and explicit limitations. |
| `docs/ssh-native-validation.md`, `ssh-postfix-validation.md` | Historical core-tool evidence stays historical. Do not rewrite it as verification of new SSH tool names/lifecycle; link fresh validation separately. |
| `docs/ssh-launch.md`, `ssh-terminal.md` | Check adjacent claims/selection wording; preserve configured-only children and explicit helper targeting. |

## Acceptance evidence and remaining work

Step 01 establishes API feasibility, the guarded tool list, state matrix, selection/capture rules, lifecycle ordering, concurrency restrictions and migration inventory. Both version probes pass. Source inspection confirms startup/tree transcript restoration and top-level versus nested queue semantics.

The preceding paragraph records step-01 evidence only. Subsequent source work implemented the controller and remote-only tools. Durable tests now cover real Pi 1.3.0/1.4.0 SDK loading with a display-equivalent owner in both orders, default-enabled SSH, direct/nested/QuickJS dispatch, isolated local/remote file and shell effects, fresh-turn generation admission, request declarations, branch/tree/reload reconstruction and file-backed clear/resume. Existing authority, protocol, mutation, helper and child fixtures remain applicable. The historical core-override implementation fails the new default-coexistence tests in both versions/orders.

Subsequently, an explicitly authorized [live smoke](ssh-isolation-live-validation.md) verified the new SSH names, clean real endpoint effects, local sentinels, guards and clear/restore on Pi 1.4.0 in both fixture load orders. Still unverified: real pi-tool-display rendering, production loader/command/UI composition, live restored-child execution, cancellation/fault injection and remote quiescence. No panes, running-session reload or dependency upgrade were used by that smoke. Independent review acceptance remains separate; the post-dispatch cancellation fix has coordinator regression verification, not a fresh independent sign-off.
