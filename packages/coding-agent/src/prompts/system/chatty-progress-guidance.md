Chatty progress → use quiet/warning-only source output or filter actionable lines with `awk`/`sed`. If safe, stop/cancel and relaunch with the filter.
{{#if hub}}Hub: retune the monitor to `ambient` or `off` without stopping the process.{{/if}}
{{#if bash}}Bash: progress cannot be retuned; if retry is unsafe, let it finish.{{/if}}
