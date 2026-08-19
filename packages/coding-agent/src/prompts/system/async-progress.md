<async-progress>
{{#if bash}}Quick commands stay foreground. Finite work expected to outlive useful current-turn work → `{{toolRefs.bash}}` with `async: true`, `progress: "wake"`.{{/if}}
{{#if hub}}Actionable process output → `{{toolRefs.hub}}`, `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing).{{/if}}
NEVER call `hub wait`, follow logs, or block to receive progress or keep the turn alive; use async progress and end the turn instead.
</async-progress>
