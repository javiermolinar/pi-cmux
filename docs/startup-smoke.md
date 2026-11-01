# Local Pi startup smoke

On **2026-10-27**, the user authorized one background Pi workspace and one background Pi tab. Both launches used `cmux_start_pi` with `focus: false`, no prompt, no inherited history and no related task marker. Neither launch was retried.

## Environment

- Code: `2a55d8f3392069828f4755d0bc8ed5142bf8e4d6`; `extensions/` and `lib/` matched that commit. Local release metadata was prepared for **0.3.0**.
- cmux **0.65.2 (111)**, build `9d01f956c`; Pi **1.4.0**.
- Local host: `javimolinas-MacBook-Pro.local`.
- Package configuration points to `/Users/javimolina/pi-cmux`; both child process working directories independently matched that checkout.
- Source surface: `8d5fe537-6d75-434a-be78-4a73365f428f`, in ordinary local workspace `7d007fe1-e4d7-4fb0-b398-c7b3036b660c`.

## Observed results

Both tool calls reported **exact child Pi binding observed**, not merely successful command dispatch. Read-only cmux topology and binding-store inspection recorded the following identities; `ps` and `lsof` independently confirmed live local Pi processes and their working directories.

| Placement | Workspace UUID | Surface UUID | Pi PID | Session ID |
|---|---|---|---|---|
| New sidebar workspace | `9051f934-a851-43ec-97e1-5ce3b314b2d8` | `9cb7aabc-42d3-409d-8190-479d96020505` | `57984` | `01a17e2e-a308-709b-bf48-f80ed4be0de1` |
| New tab in source workspace | `7d007fe1-e4d7-4fb0-b398-c7b3036b660c` | `f3d35c6b-b888-4751-b193-5dce1722ddc3` | `58273` | `01a17e2f-5276-7118-a361-cf5056bbc545` |

The bindings had distinct conversation and task IDs and role `chat`. The first post-launch identity check still showed the source surface focused. Both test surfaces were left open. No task prompts, SSH operations, cleanup, reloads or input into existing sessions were performed.

## Limits

This verifies no-prompt startup through ordinary-local-workspace create + respawn and protected local-context tab creation, with the default minimal Pi PATH and compact orientation bootstrap. A binding is not task readiness, prompt processing or completion.

It does not establish right/down split behavior, long-prompt size limits, live transport-failure handling, cancellation, handoffs, result delivery, persisted resume, SSH execution or other layouts. Those require separate scope and evidence. The recorded UUIDs and PIDs are historical evidence, not permission for later interaction or cleanup.

## Task-aware placement follow-up

After the task-aware placement change, the user authorized one read-only reviewer smoke. `cmux_start_pi` received `role: "review"`, a short review prompt and title `Placement smoke test`, with placement omitted. The tool reported a **right split** and **exact child Pi binding observed**. The parent remained open; no launch retry or cleanup was performed.

This confirms one default related-reviewer launch, not the subsequent-agent tab policy, handoffs, down splits, arbitrary layouts, review completion or result delivery. Evidence is the launch tool's binding confirmation; no separate process/cwd inspection or environment-version check was performed for this follow-up.
