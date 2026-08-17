import { beforeAll, describe, expect, test } from "bun:test";
import * as os from "node:os";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { buildAsyncProgressBlock } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import {
	ASYNC_PROGRESS_MESSAGE_TYPE,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
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
		expect(content(message)).toContain("output events were emitted");
		expect(content(message)).toContain("no action is required");
	});

	test("renders the custom message as sanitized progress rather than a completion", () => {
		const message = buildAsyncProgressBatchMessage([
			entry("bg_7", `\u001b[31m${os.homedir()}/private/output\rone\tvalue\u001b[0m`),
		]);
		if (!message) throw new Error("Expected progress message");
		const rendered = Bun.stripANSI(buildAsyncProgressBlock(message).render(80).join("\n"));

		expect(rendered).toContain("Background job progress [bash] bg_7");
		expect(rendered).toContain("~/private/outputone");
		expect(rendered).toMatch(/one +value/);
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain(os.homedir());
		expect(rendered).not.toContain("completed");
	});
});
