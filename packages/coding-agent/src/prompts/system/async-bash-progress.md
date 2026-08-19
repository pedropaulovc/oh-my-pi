# Background Bash Push Events
For a finite command whose output may require action before it exits, call `{{toolRefs.bash}}` with `async: true` and `progress: "wake"` instead of polling.
- The harness retains every complete, non-empty merged stdout/stderr line and emits progress at most once per second; when the agent is idle, it starts a follow-up turn.
- Lines emitted while the agent is busy are retained and delivered together in the next progress batch; no queued event is replaced by a newer event.
- Use `progress: "ambient"` only when updates may wait for an already-active turn; ambient progress never starts a turn.
- Progress and command completion are separate notifications. Continue other useful work after arming the command and react when the harness delivers either notification.
