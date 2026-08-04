<system-notice>
{{#if multiple}}Progress from {{jobs.length}} background jobs that are STILL RUNNING. No result is available yet and no action is required — keep working unless this changes what you should do next.
{{else}}Progress from background job {{jobs.[0].jobId}}, which is STILL RUNNING. No result is available yet and no action is required — keep working unless this changes what you should do next.
{{/if}}{{#each jobs}}── {{this.jobId}}{{#if this.label}} ({{this.label}}){{/if}}{{#if this.elapsed}} · {{this.elapsed}}{{/if}} ──
{{this.text}}
{{/each}}{{#if reminder}}
This monitor is still armed and will keep interrupting you. Stop it with `hub` `{"op":"monitor","ids":[{{reminderIds}}]}`, or cancel the job with `{"op":"cancel","ids":[{{reminderIds}}]}`.
{{/if}}
</system-notice>
