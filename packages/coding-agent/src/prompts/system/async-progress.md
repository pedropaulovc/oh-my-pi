<async-progress>
{{#if bash}}Finite commands → `{{toolRefs.bash}}` with `async: "auto"`, `progress: "wake"` (quick stays inline). NEVER use `async: true` unless the user explicitly requests immediate background.{{/if}}
{{#if hub}}Actionable process output → `{{toolRefs.hub}}`, `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing).{{/if}}
NEVER call `hub wait`, follow logs, or block to receive progress or keep the turn alive; use async progress and end the turn instead.
</async-progress>
