{{#if multiple}}The following background jobs are STILL RUNNING.{{else}}The following background job is STILL RUNNING.{{/if}} {{#if wake}}This event woke you so you can inspect the update and act if needed.{{else}}This is an ambient progress update; no action is required.{{/if}}

{{#each jobs}}
### {{jobId}} ({{elapsed}})

{{text}}
{{/each}}
