<system-notice>
{{#each jobs}}<job-progress id="{{jobId}}"{{#if type}} type="{{type}}"{{/if}} elapsed="{{elapsed}}">
{{#if suppressedEvents}}<suppressed events="{{suppressedEvents}}" reason="rate-limit"{{#if artifactId}} full-output="artifact://{{artifactId}}"{{/if}} />
{{/if}}{{#if hasOutput}}<output{{#if truncated}} truncated="true"{{#if artifactId}} full-output="artifact://{{artifactId}}"{{/if}}{{/if}}>
{{#if truncated}}<head>
{{head}}
</head>
<tail>
{{tail}}
</tail>{{else}}{{text}}{{/if}}
</output>
{{/if}}
</job-progress>{{#unless @last}}
{{/unless}}{{/each}}{{#if wake}}
Resume your work using {{#if multiple}}these updates{{else}}this update{{/if}}.
{{/if}}
</system-notice>{{#if chattyGuidance}}
<system-reminder>
{{chattyGuidance}}
</system-reminder>{{/if}}
