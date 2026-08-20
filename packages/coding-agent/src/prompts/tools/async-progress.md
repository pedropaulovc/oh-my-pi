<system-notice>
{{#each jobs}}<job-progress id="{{jobId}}"{{#if type}} type="{{type}}"{{/if}} elapsed="{{elapsed}}">
<output{{#if truncated}} truncated="true"{{#if artifactId}} full-output="artifact://{{artifactId}}"{{/if}}{{/if}}>
{{#if truncated}}<head>
{{head}}
</head>
<tail>
{{tail}}
</tail>{{else}}{{text}}{{/if}}
</output>
</job-progress>{{#unless @last}}
{{/unless}}{{/each}}{{#if wake}}
Resume your work using {{#if multiple}}these updates{{else}}this update{{/if}}.
{{/if}}
</system-notice>
