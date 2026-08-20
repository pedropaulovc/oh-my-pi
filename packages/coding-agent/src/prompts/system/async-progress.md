<async-progress>
{{#if bash}}Finite commands → `{{toolRefs.bash}}` with `async: "auto"`, `progress: "wake"` (quick stays inline). NEVER use `async: true` unless the user explicitly requests immediate background.{{/if}}
{{#if hub}}Actionable process output → `{{toolRefs.hub}}`, `progress: "wake"` (`op: "start"` new; `op: "monitor"` existing).{{/if}}
Noisy output → lower source verbosity (quiet or warning-only) or filter to actionable lines. If safe to retry, stop/cancel and start again with less output.
{{#if hub}}Hub can instead retune its monitor to `ambient` or `off` without stopping the process.{{/if}}
{{#if bash}}Bash cannot retune progress; if retry is unsafe, let it finish.{{/if}}
NEVER call `hub wait`, follow logs, or block to receive progress or keep the turn alive; use async progress and end the turn instead.
</async-progress>
