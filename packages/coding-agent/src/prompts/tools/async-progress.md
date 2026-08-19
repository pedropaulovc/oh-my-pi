<system-notice>
{{#if multiple}}{{jobs.length}} background jobs emitted output.{{#if wake}} Resume your work using the updates below.{{/if}}
{{else}}Background job {{jobs.[0].jobId}} emitted output.{{#if wake}} Resume your work using the update below.{{/if}}
{{/if}}{{#each jobs}}<job-progress id="{{jobId}}"{{#if type}} type="{{type}}"{{/if}} elapsed="{{elapsed}}">
<output>
{{text}}
</output>
</job-progress>{{#unless @last}}
{{/unless}}{{/each}}
</system-notice>
