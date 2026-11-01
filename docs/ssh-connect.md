# SSH connection API

The bundle supplies remote-only SSH tools, a branch-local selection controller and source-checked current-input authority. Registration itself does not connect or read config. See [supported requests](ssh.md#connect).

```ts
registerSshConnect(pi, adapter, authority);
registerSshAliasSave(pi, adapter, authority);
```

## Authority

`authority.currentRequest(ctx, action, parameters)` must synchronously return exactly `true` for the current user-requested action and exact parameters. Saved state, discovery, model booleans and previous UI approval are not authority. Integrations without a reliable authority source must refuse.

Both actions require the owning local session/cwd, enabled runtime and uncancelled signals. `ssh_connect` is model-only and sequential: nested/codemode callers cannot connect or replace targets. Bind, validate and clear commands are idle-only. Before connection effects, the selection controller persists prior guarded membership; capture failure blocks connection. Sequential dispatch plus in-flight guards prevent overlap. Strict schemas reject unknown/secret/approval/backend fields, accessors and non-data objects before effects.

Connect requires a concrete destination. `remoteCwd` is optional: omission and literal `~` normalize to remote-home intent. Explicit non-home paths must be absolute. The authority callback receives that normalized request, so a host-only grant cannot authorize an arbitrary absolute path supplied by the model.

Home resolution first revokes prior dispatch and saves a pending destination-only record. A fixed, nonce-framed remote `HOME` query runs under the existing bounded transport; UTF-8, absolute-path and control/length validation precede selection. The resolved evidence retains a runtime/request fence across the caller's await boundary. Only the verified absolute target is activated and saved; a separate quiet cwd validation then commits readiness synchronously after the final authority check. Absolute-path requests skip the home query. Neither operation retries. Ready membership is declared before the next model request, but data-tool execution requires that generation's fresh turn. A connection result does not authorize SSH data calls from the old response batch.

The bundled lease aborts on new input, steering or lifecycle changes; late results cannot enable dispatch or disconnect newer targets. Pending intent blocks local fallback and older-target restoration, including after reload; it requires a fresh connection request, not `ssh-validate`. Failure burns that input's attempt. No raw SSH command or discovered backend is adopted.

Optional `authority.begin` returns a release function with a revocation signal. It supplements, never replaces, the final authority check. Direct probe users must commit once or discard.

`decideSshConversation` is a pure supplied-field helper: question, validated target or cancellation. It neither parses language nor grants consent. Unresolved `ambiguousHostCandidates` require clarification; clear them after a concrete choice. A supplied destination with no directory is complete and defaults home; unresolved hosts or invalid explicit paths ask one field. Cancellation before dispatch has no effects; cancellation afterward cannot undo a started connection.

## Alias saving

`ssh_alias_save` accepts `{alias, hostname, user?, port?}`, never approval flags. A trusted Pi/RPC UI previews the exact append, including its leading newline, and requires fresh confirmation. No dialog-capable UI means no new save. Decline/cancel/stale confirmation writes nothing and does not block an independently requested connection.

Identical aliases return without writing/prompting; conflicts fail. The saver never connects. Saving supports narrow ASCII hostname/user tokens, not IPv6; broader one-off destinations remain supported.

Safeguards:

- Fixed trusted home; no directory creation. Check ancestor ownership/writability and refuse symlinks.
- At most 256 KiB; bounded no-follow/nonblocking regular-file reads. Require user-owned, single-link files without group/other write access.
- Accept only simple literal Host blocks and known options. Refuse Include/Match/globals/patterns/duplicates/quoting/continuations/non-ASCII/rich syntax; refusal does not imply invalid OpenSSH config.
- Snapshot bytes and file identity before preview. After approval, recheck under an exclusive cooperative lock and issue one append. New config uses exclusive creation at 0600; existing bytes/comments/permissions/inode remain intact. Sync and verify.
- Never steal stale locks, overwrite newer content, retry a partial write or roll back uncertain results. Remove only the operation's own lock.

Noncooperating editors can race the final check, including parent/path replacement. Node APIs do not provide atomic compare-and-append here. Partial writes/fsync failures or detected post-write conflicts require local inspection; crash durability is not guaranteed.

Only resolved target metadata or pending destination intent is persisted. Existing config/credentials never enter prompts or result details. Generated nonsecret alias fields and tool arguments can appear in the normal transcript.

## Evidence

Connection/alias/integration fixtures cover complete/missing/ambiguous/manual inputs, strict fields, stale authority, authentication, cancellation, exact preview, decline, preservation and conflicts. They do not prove model-language behavior, live UI/RPC trust or elimination of external-editor races.
