{{#if multiple}}The following output events were emitted by background jobs.{{else}}The following output events were emitted by a background job.{{/if}} {{#if wake}}The harness pushed this event and started a follow-up turn so you can inspect the update and act if needed.{{else}}This is an ambient progress update; no action is required.{{/if}}

{{#each jobs}}
### {{jobId}} ({{elapsed}})

{{text}}
{{/each}}
