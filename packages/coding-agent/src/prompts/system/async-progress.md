<async-progress>
{{#if bash}}Actionable finite-command output → `{{toolRefs.bash}}` with `async: true`, `progress: "wake"`.{{/if}}
{{#if hub}}Actionable process output → `{{toolRefs.hub}}`, `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing).{{/if}}
After arming wake progress, continue other work; when none remains, end the turn so the harness can wake you.
NEVER call `hub wait`, `hub logs` with follow, or another blocking tool merely to receive that progress or keep the turn alive. Block only when the user requires synchronous readiness/exit/pattern handling or the immediately next action cannot proceed without it.
</async-progress>
