# hub

> The single agent-coordination surface: peer messaging over the process-global mailbox bus, background-job control, and supervision of shared long-running processes.

Merged from the former `irc`, `job`, and `launch` tools; each op family keeps its old behavior and rendering.

## Source
- Entry: `packages/coding-agent/src/tools/hub/index.ts` (schema, `HubTool`, unified `wait`, renderer dispatch)
- Messaging half: `packages/coding-agent/src/tools/hub/messaging.ts`
- Jobs half: `packages/coding-agent/src/tools/hub/jobs.ts`
- Launch half: `packages/coding-agent/src/tools/hub/launch.ts`
- Shared types: `packages/coding-agent/src/tools/hub/types.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/hub.md`
- Key collaborators:
  - `packages/coding-agent/src/irc/bus.ts` — process-global `IrcBus`: per-agent mailboxes, delivery, waiter matching.
  - `packages/coding-agent/src/registry/agent-registry.ts` — process-global agent directory and status.
  - `packages/coding-agent/src/registry/agent-lifecycle.ts` — revival of parked recipients on direct send.
  - `packages/coding-agent/src/session/agent-session.ts` — `deliverIrcMessage(...)`: recipient-side injection and wake turns.
  - `packages/coding-agent/src/async/job-manager.ts` — job registry, cancellation, delivery suppression, smart poll ladder.
  - `packages/coding-agent/src/launch/client.ts` / `broker.ts` / `presence.ts` / `protocol.ts` — process-supervision broker.
  - `packages/coding-agent/src/config/settings-schema.ts` — `irc.timeoutMs`, `async.pollWaitDuration`, `launch.enabled`.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `op` | `"send" \| "wait" \| "inbox" \| "list" \| "jobs" \| "cancel" \| "monitor" \| "start" \| "ps" \| "logs" \| "stop" \| "restart" \| "describe"` | Yes | Operation. |
| `to` | `string` | `send` (peer) | Recipient agent id, or `"all"` for broadcast. Mutually exclusive with `name`. |
| `message` | `string` | `send` (peer) | Message body. Empty-after-trim is rejected. |
| `replyTo` | `string` | No | `send`: message id being answered. |
| `await` | `boolean` | No | Peer `send`: after delivery, block until the next message from that peer arrives. Invalid with `to: "all"`. |
| `from` | `string` | No | `wait`: only accept a message from this agent id (pure message wait). |
| `ids` | `string[]` | No | `wait`: job ids to watch (omit = all running jobs); `cancel`: job ids to kill (required); `monitor`: job ids to arm (omit = report all). |
| `progress` | `{ every?, match?, wake?, lines? }` | No | `monitor`: reporting policy to apply; omit to stop reporting while the job keeps running. |
| `timeoutMs` | `number` | No | Peer `send` with `await`, and message/job `wait`: milliseconds; `0` waits indefinitely. Defaults to `irc.timeoutMs` for a reply/pure-message wait and to the poll window when jobs are watched. |
| `peek` | `boolean` | No | `inbox`: leave messages in the process-global bus mailbox. Note that messages already buffered on the live recipient session are still drained into this result by the current implementation. |
| `name` | `string` | process ops | Stable project-scoped launch name (1-48 chars). On `send`/`wait` it routes the op to the process broker. |
| `application`, `args`, `env`, `cwd`, `pty`, `ready`, `restart`, `persist`, `detached` | — | `start` | Launch spec, unchanged from the former `launch` tool. |
| `lines`, `head`, `grep`, `follow`, `cursor` | — | `logs` | Log window controls, unchanged. |
| `for`, `pattern` | — | `wait` (name) | Process lifecycle condition / output regex. |
| `text`, `enter`, `keys`, `signal` | — | `send` (name) | Process stdin / terminal keys / signal. |
| `timeout` | `number` | No | `logs`/`stop`/`wait`-with-`name`: seconds; default 30 (stop: 5). |

## Op families and dispatch
- **Messaging** — `send` (with `to`), `inbox`, `list`, and `wait` with `from`. Fire-and-forget sends return delivery receipts (`injected`/`woken`/`revived`/`failed`); direct sends can revive parked agents, while broadcasts target visible live peers without reviving every parked agent. `await: true` waits for one reply after delivery. A busy recipient with async execution disabled may auto-reply rather than strand an awaiting sender.
- **Jobs** — `wait` (bare or with `ids`), `cancel`, `jobs`, `monitor`. Owner-scoped visibility, watch/unwatch delivery suppression, `acknowledgeDeliveries` on returned completions, 500 ms `onUpdate` snapshots while waiting, and the `async.pollWaitDuration` fixed/smart wait window. `jobs` is the former job-list snapshot plus the roster of running subagents with no running job entry.
- **Processes** — `start`, `ps`, `logs`, `stop`, `restart`, `describe`, plus `send`/`wait` when they carry `name`. Exact behavior of the former `launch` tool; `ps` is the broker's `list`. See the launch sections below.

`send` with both `to` and `name` is rejected as ambiguous. `wait` routes by target: `name` → process wait; otherwise the unified coordination wait.

## The unified `wait`
One blocking primitive. It resolves job legs (explicit `ids`, owner-scoped and silently filtered, or every running job the caller owns) and — when the session can message peers — parks a bus waiter, then races:
- every watched running job's `job.promise`,
- the first matching incoming message (`from`-filtered when given),
- the wait window — explicit `timeoutMs` if passed (`0` = no window), else `manager.nextPollWaitMs(...)` under `smart` or the fixed `async.pollWaitDuration`,
- the tool-call abort signal.

Outcomes:
- A message wins (even a photo-finish: a message consumed by the bus waiter is never dropped) → the message is returned exactly like the former `irc wait` (`details.waited`), and the jobs keep running; their results still self-deliver.
- A job settles or the window elapses → a job snapshot exactly like the former `job` poll (`details.jobs`, `## Completed` / `## Still Running` sections). An all-running snapshot is flagged `useless` and rendered as a displaceable waiting frame that the next `hub` call supersedes.
- No job legs: pure message wait with peer liveness (bounded by `irc.timeoutMs`); with no running peers either, it returns `No running background jobs to wait for.` immediately (plus the jobless running-agent roster when one exists).
- Explicit `ids` that match nothing visible → `No matching jobs found for IDs: ...` with per-id agent hints (`history://<id>`), never a hang.
- A message already buffered on the session satisfies the wait before anything is watched.

Smart-ladder bookkeeping (`recordPollWaitEnd`) runs only when the smart window was actually used (no explicit `timeoutMs`).

## Outputs
- Messaging and job results: single text block plus `details: CoordinationDetails` — `{ op, from?, to?, receipts?, waited?, inbox?, peers?, jobs?, cancelled?, agents? }`. Shapes are unchanged from the former tools except that job-op details now carry `op` (`"wait" | "cancel" | "jobs"`).
- Process results: `details: LaunchToolDetails` — `{ op, daemon?, daemons?, cursor?, timedOut?, state?, terminalRows?, matched?, spec? }`, unchanged from the former `launch` tool (internally `ps` stores the broker op `list`).
- Streaming: job-watching waits emit `onUpdate` every 500 ms with fresh snapshots; everything else is single-shot.

## Availability
- The tool is always registered (`loadMode: "essential"`).
- Messaging ops require an `AgentRegistry` and a caller agent id; otherwise they return `Peer messaging is unavailable in this session.` (`isIrcEnabled` still gates the peer-roster prompt sections: true for every subagent and for any session that can still spawn subagents).
- Job ops require `session.asyncJobManager`; otherwise `Async execution is disabled; no background jobs are available.`
- Process ops require `launch.enabled`; otherwise `Process supervision is disabled (launch.enabled=false).`

## Approval
`hubApproval` (per-call): `start`, `stop`, `restart`, and `send`-to-process are `exec`; everything else — messaging, job control, `monitor`, `ps`/`logs`/`describe`/`wait` — is `read`.

## `monitor` — progress from a running job
`monitor` controls the agent-facing progress channel (see [`bash.md`](./bash.md) for arming one at spawn time). It never touches the work itself, only whether and how that work reports back.

```json
{"op":"monitor","ids":["bg_1"],"progress":{"every":30,"match":"^error","wake":true}}
{"op":"monitor","ids":["bg_1"]}
{"op":"monitor"}
```

- **Arm/retune** — `ids` + `progress` replaces the job's policy wholesale. `every` (seconds) heartbeats, `match` (regex over new output lines) fires on a line, `wake` decides whether an update may start a turn while the agent is idle, `lines` caps how much output rides along.
- **Stop** — `ids` with no `progress` clears the policy; the job keeps running, it just stops reporting.
- **Report** — no `ids` lists every running job the caller owns with its current policy.

Because the policy lives on the job and is read live, a retune takes effect on the next update — including for jobs started before the agent decided it wanted them watched, and for auto-backgrounded bash, which carries no spawn-time parameters.

Delivery is owner-scoped and mirrors the completion path: `AsyncJobManager.setProgressPolicy` rejects another agent's job as not-found, and updates are suppressed for any job under an in-flight `wait` (that wait already returns snapshots) or whose delivery was acknowledged. An update whose job has since settled is dropped — the completion supersedes it.

Two delivery modes, chosen per job by `wake`:

| | `wake: false` (default) | `wake: true` |
| --- | --- | --- |
| Yield kind | `async-progress` (`skipIdleFlush`) | `async-progress-wake` |
| When it lands | next step boundary of an active run | starts a follow-up turn |
| While the agent is idle | not emitted at all | emitted |

`every` is floored by `async.progress.minIntervalMs`; a clamped value is reported rather than applied silently. `async.progress.maxLines` / `maxChars` bound one update, and after every `async.progress.wakeReminderAfter` wake updates the message appends a reminder naming the `monitor` call that stops it.

## Starting and readiness (processes)
`application` and `args` are separate fields, so callers do not need shell quoting:

```json
{
  "op": "start",
  "name": "web",
  "application": "bun",
  "args": ["run", "dev"],
  "ready": { "log": "Local:.*http", "port": 5173, "timeout": 30 }
}
```

Defaults: `cwd` = session directory, `args: []`, `env: {}`, `pty: true`, `restart: "no"`, `persist: false`, `detached: false`, readiness timeout 30 s. `detached: true` implies `persist`, forces `pty: false`, and disables stdin. `ready.log` is a regex over captured output; `ready.port` probes TCP at `ready.host` (default `127.0.0.1`); when both are present, both must pass. A readiness timeout leaves the process running and reports its state.

Names are stable and unique within one project directory. A live name must be stopped or restarted; starting a completed name creates a new launch and rotates its prior output log.

## Logs, input, signals (processes)
```json
{"op":"logs","name":"web","grep":"error|warn","lines":50}
{"op":"logs","name":"web","follow":true,"cursor":1842,"timeout":30}
{"op":"send","name":"debugger","text":"breakpoint set --name main"}
{"op":"send","name":"debugger","keys":["CTRL_C"]}
```
Each logs result returns a byte cursor; `follow: true` waits until output advances beyond it, the process exits, or the timeout elapses. The broker keeps a 25 MiB current log plus one rotated log. Keys: `ENTER`, `TAB`, `ESCAPE`, `CTRL_C`, `CTRL_D`, arrows. Signals: `SIGINT`, `SIGTERM`, `SIGHUP`, `SIGQUIT`, `SIGKILL`. Input is one shared stream across all project clients.

## Cross-instance lifecycle (processes)
Unchanged from the former `launch` tool: the first process op starts a detached broker over a private socket under `~/.omp/run/daemons/<project-hash>/`; every omp instance in the project shares names, logs, and state. After the last omp process exits, the broker stops non-persistent processes and exits. `persist: true` opts out of last-client teardown; restart policies (`no`/`on-failure`/`always`) use bounded exponential backoff up to 30 s.

## Limits & Caps
- Mailboxes: 100 messages per agent (`MAILBOX_CAP`); oldest dropped beyond the cap.
- `irc.timeoutMs` default `120_000`; `0` disables; negative/non-finite fall back to the default.
- Poll window: `async.pollWaitDuration` — `5s`/`10s`/`30s`/`1m`/`5m`/`smart` (default); smart ladder `[5s..5m]` climbing per back-to-back wait, resetting after 60 s without waiting.
- Job retention 5 min; manager max-running fallback 15; `async.maxJobs` clamped 1..100.
- Launch names 1-48 chars; `ready.port` 1..65535; `logs`/`wait`/`stop` timeouts capped at one hour.

## Errors
- Most validation/availability failures are text results with `isError: true`: messaging unavailable, missing `to`/`message`, self-send (`Cannot send a message to yourself.`), `await` with `to:"all"`, `to`+`name` on one send, missing `ids` on `cancel`, and launch disabled. The async-disabled `jobs`/`cancel` response is an exception: it returns `Async execution is disabled; no background jobs are available.` with an empty job list and no `isError` flag.
- Launch validation (missing `name`/`application`, bad `ready.port`, unsupported key) throws `ToolError`, exactly as before.
- A `wait` timeout is a normal result (`waited: null` or an all-running snapshot flagged `useless`), never an error.
- Per-recipient delivery failures surface as `failed` receipts; `send` is `isError` only when nothing was delivered.

## Notes
- The IRC bus, agent registry, job manager, and launch broker are unchanged subsystems; only the tool surface merged.
- A running recipient still gets messages injected as non-interrupting asides (`irc:incoming` custom messages, `prompts/system/irc-incoming.md`); replies are real turns.
- Messaging a parked agent revives it — the only resume primitive; the task tool has no `resume` parameter.
- TUI rendering is preserved per family: messaging cards (`IRC ➤ / ⟵` headers), job waiting frames (displaceable, shimmering rows), and launch frames render byte-identically to the pre-merge tools; the `hub` renderer only dispatches.
