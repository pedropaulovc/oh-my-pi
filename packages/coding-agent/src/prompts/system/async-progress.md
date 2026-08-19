<async-progress>
{{#if bash}}Actionable finite-command output → `{{toolRefs.bash}}` with `async: true`, `progress: "wake"`.{{/if}}
{{#if hub}}Actionable long-running-process output → `{{toolRefs.hub}}` with `op: "start"`, `progress: "wake"`.{{/if}}
Never poll.
</async-progress>
