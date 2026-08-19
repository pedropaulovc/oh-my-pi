<async-progress>
{{#if bash}}Actionable finite-command output → `{{toolRefs.bash}}` with `async: true`, `progress: "wake"`.{{/if}}
{{#if hub}}Actionable process output → `{{toolRefs.hub}}`, `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing).{{/if}}
Never poll.
</async-progress>
