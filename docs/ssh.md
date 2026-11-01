# Experimental SSH execution

Pi, credentials, session files and other extensions stay local. The remote-only tools are `ssh_read`, `ssh_write`, `ssh_edit` and `ssh_bash`; user `!`/`!!` commands also use the bound ready SSH target through this adapter. Registration does not connect, scan config or claim local core-tool names. SSH can stay enabled alongside an extension owning `read`, `write`, `edit` and `bash`, such as `pi-tool-display`. Its core-tool renderers do not automatically customize the new SSH tools; real-package rendering has not been validated.

## Connect

```text
Connect to javi
Connect to javi in ~
Connect to javi in /srv/project
Connect to javi in "/srv/project with spaces"
```

Use a direct idle interactive/RPC prompt. The destination is required; omitting the directory defaults to the remote account's home, as does an explicit `~`. The connector resolves the remote `HOME`, then stores and validates its absolute path—never your Mac's home. Other directory values must be absolute; `~/project` and `~user` require clarification rather than silently falling back to home. Complete requests proceed without a picker or extra yes/no gate; an unresolved destination or invalid explicit path asks one question. Aliases, manual hosts/IPs and `user@host` are accepted. Discovery suggests but never selects.

The input parser supports simple English/Spanish requests and literal follow-up answers, not arbitrary phrasing. Quoted requests, expanded file content, peers, streaming steering and saved state grant no connection. For an unrecognized request, use:

```text
/ssh-bind {"destination":"javi"}
/ssh-bind {"destination":"javi","remoteCwd":"/srv/project"}
/ssh-validate
/ssh-clear
```

Bind selects/validates; validate explicitly rechecks a resolved saved target; clear removes remote intent and restores the prior available local tool membership. All three commands require Pi to be idle. `ssh_connect` is a sequential, model-only control, not callable from codemode/nested tools. Home requests perform one bounded home lookup and one cwd validation, not retries. While resolving home, prior dispatch is revoked and only pending destination intent is saved. Failure or reload in that phase remains blocked until a fresh connection request or explicit clear; it cannot restore an older target or fall back locally. Resume and child launches restore resolved targets as **configured**, never ready. Failed connection attempts need a new request.

## Tool selection and local guards

Local startup leaves other owners and the current local selection unchanged; SSH data tools are registered but inactive. Before a connection effect, the adapter captures the selected local file/shell names once for that SSH episode. Readiness selects only their counterparts (`read → ssh_read`, `write → ssh_write`, `edit → ssh_edit`, `bash → ssh_bash`) before the next request; execution waits for a fresh model turn. A read-only selection does not gain write or shell access. Tool filters still apply; a missing required counterpart blocks the SSH data loadout rather than enabling a substitute.

| State | Local file/shell counterparts | SSH data tools |
|---|---|---|
| Local, no SSH intent (enabled or disabled) | Unchanged | Inactive; reject execution |
| Connecting, resolving home, configured, disconnected, saved pending/invalid intent, or disabled with intent | Blocked | Inactive; reject execution |
| Ready, before the next model turn | Blocked | Mapped names selected; transition-batch calls reject |
| Ready, fresh current-generation turn | Blocked | Selected counterparts execute remotely |
| Explicit idle `/ssh-clear` | Prior available local membership restored | Inactive; reject execution |

The guarded local names are `read`, `write`, `edit`, `bash`, `powershell`, `grep`, `find` and `ls`. Guards apply at Pi's tool-call boundary, including stale cached, nested and codemode calls; hiding a name alone is not protection. There are no SSH search/list/PowerShell counterparts. Use `ssh_bash` for remote search/listing only if shell access was already selected. SSH tools never delegate locally, and local names are never rewritten to SSH calls.

`/ssh-clear` restores the captured guarded names that remain registered and permitted, while preserving **current** unrelated tool choices. Its clear record retains that known membership across exit/resume before another request. Newer persisted local choices take precedence. Resume, tree navigation, reload and children restore selection/intent, never readiness or automatic reconnect; a child captures its own local selection. Legacy or corrupt/missing capture data cannot establish an exact prior selection: clear warns and leaves unknown membership disabled instead of enabling default write/shell tools.

This is not an extension sandbox. Already-admitted local work cannot be retroactively cancelled; arbitrary tools, aliases and direct extension filesystem access remain local. An earlier third-party `user_bash` handler can intercept `!`/`!!` before this adapter. Stale contexts and old target tickets reject; a new target requires a fresh model turn, not replay of the old batch.

**Migration:** integrations must call the `ssh_*` names for remote work. Old transcripts keep their original tool names; resuming them does not safely replay or reinterpret old core calls. Reconnect/validate explicitly, inspect selection and issue fresh operations. `PI_CMUX_SSH=0` is an execution disable control, not a coexistence workaround.

## Authentication and aliases

Configure OpenSSH keys/agent and host trust outside chat. Never paste passwords, private keys or passphrases. Connections are noninteractive; no key setup or automatic retry occurs. Trusted SSH config helpers/account startup still apply.

```text
Save alias work for dev@host.example port 2222
```

Alias saving is separate and optional. Pi shows the exact addition to `~/.ssh/config` and requires fresh confirmation; declining does not block a requested one-off connection. Identical aliases need no prompt. Rich/unsafe/conflicting config is refused. No host registry is created. See [save safeguards](ssh-connect.md#alias-saving).

## Controls

Set before starting Pi:

| Variable | Default | `0` disables |
|---|---|---|
| `PI_CMUX_SSH` | `1` | SSH data execution, connections, validation, discovery and saves |
| `PI_CMUX_SSH_DISCOVERY` | `1` | Config/cmux suggestions only |
| `PI_CMUX_SSH_ALIAS_SAVE` | `1` | Alias saves only |

The adapter never registers local core names, whether enabled or disabled. With `PI_CMUX_SSH=0`, SSH tools remain registered but refuse execution, and disabled sessions without remote intent stay local. Saved, pending or invalid remote intent still blocks local file/shell calls and this adapter's user-shell path until idle `/ssh-clear`; re-enabling alone never grants readiness. Resolved targets require explicit validation, pending home intent a fresh connection request. Change the environment before a user-requested restart/reload; it does not alter an already loaded adapter.

## Helpers and children

Ready SSH sessions default helpers to remote cwd/PATH. Use tool `target: "local"` or `/cmt --local k9s` for the Mac; `--remote` requires readiness. Terminal creation is not command completion.

Same-project fresh/related/reviewer tabs/splits keep Pi local and transfer configured-only selection. Host authority is separate from origin navigation and messaging.

## Limits

- Ordinary local cmux workspaces only. Remote-owned/cloud/relay/tmux layouts, SSH sidebar workspace creation, explicit cwd changes, handoffs/worktrees/Git/zoxide and new browser previews are refused. Existing annotation stop/retry and drafts remain available.
- Remote requirements: account shell, `/bin/bash`, `cat`, `mkdir`, `test`, POSIX `wc`, quiet startup stdout. File replies use strict byte framing; unexpected output is refused, not file data.
- File paths are literal POSIX paths; no tilde/environment expansion. The `~` special case applies only to the connection's cwd, not read/write/edit paths. Remote project instructions/extensions are not loaded automatically. Read applicable instruction files as data and establish which guidance applies before changes.
- Cancellation kills local SSH, not necessarily remote descendants. Partial effects are possible; uncertain mutations/creations are never replayed or rolled back automatically.
- Output spools remain local and cannot be opened through `ssh_read`. Local `read` remains guarded during SSH intent; do not bypass it to inspect a spool.

Real Pi SDK tests cover default coexistence with a display-equivalent core owner on Pi 1.3.0 and 1.4.0 in both load orders, including QuickJS/nested dispatch, isolated file/shell sentinels, request declarations and resume/tree/reload. They substitute SSH transport, not Pi execution boundaries. A separate [live SSH smoke](ssh-isolation-live-validation.md) passed current read/write/edit/bash, guards and clear/restore on Pi 1.4.0 in both fixture load orders. The real `pi-tool-display` package/rendering and production CLI/UI loading remain unverified.

Native evidence covers historical clean SSH core operations and ordinary-local-workspace helper/child tabs, not this tool-isolation change. Splits, persisted child resume/remote execution, live alias UI, default-home resolution, cancellation/noisy-account experiments and later launch-size changes remain unverified. No minimum cmux version is certified for this path.

[Transport](ssh-adapter.md) · [Target contract](ssh-target-contract.md) · [Connection API](ssh-connect.md) · [Discovery](ssh-discovery.md) · [Helpers](ssh-terminal.md) · [Launches](ssh-launch.md) · [Native evidence](ssh-native-validation.md) · [Post-fix evidence](ssh-postfix-validation.md) · [Smoke recipe](ssh-smoke.md)
