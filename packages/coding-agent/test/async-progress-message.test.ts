import { beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import {
	buildAsyncProgressBlock,
	buildAsyncResultBlock,
} from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import {
	ASYNC_PROGRESS_MESSAGE_TYPE,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
	buildAsyncResultBatchMessage,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";

function job(id: string): AsyncJob {
	return {
		id,
		type: "bash",
		status: "running",
		startTime: 0,
		label: id,
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

function entry(jobId: string, text: string, seq = 1): AsyncProgressEntry {
	return { jobId, text, seq, job: job(jobId), elapsedMs: 5_000, epoch: 0, delivery: "ambient" };
}

function content(message: { content: unknown } | null): string {
	if (!message || typeof message.content !== "string") throw new Error("Expected text content");
	return message.content;
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load dark theme for tests");
	setThemeInstance(theme);
});

describe("async progress messages", () => {
	test("preserves every queued event while batching updates by job", () => {
		const longEvent = "x".repeat(5_000);
		const message = buildAsyncProgressBatchMessage([
			entry("bg_1", "first", 1),
			entry("bg_1", `second\n${longEvent}`, 2),
			entry("bg_2", "important", 1),
		]);
		const jobs = message?.details?.jobs ?? [];

		expect(message?.customType).toBe(ASYNC_PROGRESS_MESSAGE_TYPE);
		expect(jobs).toHaveLength(2);
		expect(jobs[0]?.text).toBe(`first\nsecond\n${longEvent}`);
		expect(content(message)).toContain("first");
		expect(content(message)).toContain("second");
		expect(content(message)).toContain(longEvent);
		expect(content(message)).toContain("important");
		expect(content(message)).toContain("<system-notice>");
		expect(content(message)).toContain('<job-progress id="bg_1" type="bash" elapsed="5.0s">');
		expect(content(message)).not.toContain("background jobs emitted output");
		expect(content(message)).not.toContain("Resume your work");
		expect(content(message)).toEndWith("</system-notice>");
	});

	test("asks the agent to resume only when progress wakes a follow-up turn", () => {
		const wakeEntry = { ...entry("bg_3", "ready"), delivery: "wake" as const };
		const message = buildAsyncProgressBatchMessage([wakeEntry]);

		expect(content(message)).toContain("Resume your work using this update.");
		expect(content(message)).toContain("<output>\nready\n</output>");
		expect(content(message)).not.toContain("Background job bg_3 emitted output");
	});

	test("renders the custom message as sanitized progress rather than a completion", () => {
		const message = buildAsyncProgressBatchMessage([
			entry("bg_7", `\u001b[31m${os.homedir()}/private/output\rone\tvalue\u001b[0m`),
		]);
		if (!message) throw new Error("Expected progress message");
		const raw = buildAsyncProgressBlock(message).render(80).join("\n");
		const rendered = Bun.stripANSI(raw);

		expect(rendered).toContain("Background command progress bg_7");
		expect(rendered).toContain(`${theme.status.running} Background command progress`);
		expect(raw).toContain(theme.fg("accent", theme.status.running));
		expect(raw).toContain(theme.fg("accent", "Background command progress bg_7"));
		expect(rendered).toContain("~/private/outputone");
		expect(rendered).toMatch(/one +value/);
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("completed");
	});

	test("names the work instead of rendering an implementation badge", () => {
		const runningJob = job("bg_8");
		const progressMessage = buildAsyncProgressBatchMessage([{ ...entry("bg_8", "working"), job: runningJob }]);
		const completionMessage = buildAsyncResultBatchMessage([
			{ jobId: "bg_8", result: "done", job: runningJob, durationMs: 5_000, epoch: 0 },
		]);
		if (!progressMessage || !completionMessage) throw new Error("Expected progress and completion messages");

		const progress = Bun.stripANSI(buildAsyncProgressBlock(progressMessage).render(80).join("\n"));
		const completion = Bun.stripANSI(buildAsyncResultBlock(completionMessage).render(80).join("\n"));

		expect(progress).toContain("Background command progress bg_8");
		expect(completion).toContain("Background command completed bg_8");
		expect(progress).not.toContain("[bash]");
		expect(completion).not.toContain("[bash]");
	});
});
