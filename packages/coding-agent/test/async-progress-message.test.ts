import { describe, expect, test } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import {
	ASYNC_PROGRESS_MESSAGE_TYPE,
	ASYNC_PROGRESS_WAKE_MESSAGE_TYPE,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";

function job(id: string, label: string): AsyncJob {
	return {
		id,
		type: "bash",
		status: "running",
		startTime: 0,
		label,
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

function entry(overrides: Partial<AsyncProgressEntry> & { jobId: string; text: string }): AsyncProgressEntry {
	return {
		job: job(overrides.jobId, overrides.jobId),
		seq: 1,
		elapsedMs: 5_000,
		epoch: 0,
		remind: false,
		...overrides,
	};
}

function text(message: { content: unknown } | null): string {
	if (!message) throw new Error("expected a message");
	if (typeof message.content !== "string") throw new Error("expected rendered string content");
	return message.content;
}

describe("async progress message", () => {
	test("returns null for an empty batch", () => {
		expect(buildAsyncProgressBatchMessage([])).toBeNull();
	});

	test("keeps only the newest update per job", () => {
		const message = buildAsyncProgressBatchMessage([
			entry({ jobId: "bg_1", text: "stale", seq: 1 }),
			entry({ jobId: "bg_1", text: "newest", seq: 7 }),
			entry({ jobId: "bg_1", text: "older", seq: 3 }),
		]);
		const body = text(message);
		expect(body).toContain("newest");
		expect(body).not.toContain("stale");
		expect(body).not.toContain("older");
		expect(message?.details?.jobs).toHaveLength(1);
	});

	test("states the job is still running so a result is not implied", () => {
		const body = text(buildAsyncProgressBatchMessage([entry({ jobId: "bg_1", text: "step 3" })]));
		expect(body).toContain("STILL RUNNING");
		expect(body).toContain("bg_1");
	});

	test("keeps the tail when a job exceeds the line cap", () => {
		const body = text(
			buildAsyncProgressBatchMessage([entry({ jobId: "bg_1", text: "l1\nl2\nl3\nl4\nl5" })], { maxLines: 2 }),
		);
		expect(body).toContain("l4");
		expect(body).toContain("l5");
		expect(body).not.toContain("l1");
	});

	test("splits the character budget so one chatty job cannot crowd out the others", () => {
		const message = buildAsyncProgressBatchMessage(
			[
				entry({ jobId: "bg_1", text: "x".repeat(5_000) }),
				entry({ jobId: "bg_2", text: "y".repeat(5_000) }),
				entry({ jobId: "bg_3", text: "important" }),
			],
			{ maxChars: 300 },
		);
		const jobs = message?.details?.jobs ?? [];
		expect(jobs).toHaveLength(3);
		for (const entryDetails of jobs) expect(entryDetails.text.length).toBeLessThanOrEqual(100);
		expect(text(message)).toContain("important");
	});

	test("carries the wake customType only when wake is set", () => {
		const ambient = buildAsyncProgressBatchMessage([entry({ jobId: "bg_1", text: "tick" })], { wake: false });
		const waking = buildAsyncProgressBatchMessage([entry({ jobId: "bg_1", text: "tick" })], { wake: true });
		expect(ambient?.customType).toBe(ASYNC_PROGRESS_MESSAGE_TYPE);
		expect(waking?.customType).toBe(ASYNC_PROGRESS_WAKE_MESSAGE_TYPE);
		expect(ambient?.details?.wake).toBe(false);
		expect(waking?.details?.wake).toBe(true);
	});

	test("tells the agent how to stop an armed monitor when reminding", () => {
		const quiet = text(buildAsyncProgressBatchMessage([entry({ jobId: "bg_1", text: "tick", remind: false })]));
		expect(quiet).not.toContain("still armed");

		const reminded = text(buildAsyncProgressBatchMessage([entry({ jobId: "bg_1", text: "tick", remind: true })]));
		expect(reminded).toContain("still armed");
		expect(reminded).toContain('"op":"monitor"');
		expect(reminded).toContain('"bg_1"');
	});

	test("uses the plural lead-in for a multi-job batch", () => {
		const body = text(
			buildAsyncProgressBatchMessage([entry({ jobId: "bg_1", text: "one" }), entry({ jobId: "bg_2", text: "two" })]),
		);
		expect(body).toContain("2 background jobs");
		expect(body).toContain("one");
		expect(body).toContain("two");
	});
});
