import { afterEach, describe, expect, test, vi } from "bun:test";
import {
	type AsyncJob,
	AsyncJobManager,
	type AsyncJobProgressDelivery,
	type AsyncJobProgressSink,
} from "@oh-my-pi/pi-coding-agent/async/job-manager";

function heldJob(manager: AsyncJobManager, ownerId = "Main", progressDelivery: AsyncJobProgressDelivery = "ambient") {
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<(text: string) => void>();
	const jobId = manager.register(
		"bash",
		"held",
		async ({ reportAgentProgress }) => {
			started.resolve(reportAgentProgress);
			await gate.promise;
			return "done";
		},
		{ ownerId, progressDelivery },
	);
	return { jobId, report: started.promise, release: gate.resolve };
}

function recordingSink(): {
	sink: AsyncJobProgressSink;
	seen: Array<{ jobId: string; text: string; seq: number }>;
} {
	const seen: Array<{ jobId: string; text: string; seq: number }> = [];
	return {
		sink: {
			deliver: (jobId, text, _job: AsyncJob, seq) => {
				seen.push({ jobId, text, seq });
			},
		},
		seen,
	};
}

describe("AsyncJobManager model progress", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("batches every update on a fixed trailing edge without dropping events", async () => {
		vi.useFakeTimers();
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const job = heldJob(manager);
		const report = await job.report;

		report("first");
		report("second");
		report("newest");
		expect(recorder.seen.map(item => item.text)).toEqual(["first"]);

		vi.advanceTimersByTime(1_000);
		expect(recorder.seen).toEqual([
			{ jobId: job.jobId, text: "first", seq: 1 },
			{ jobId: job.jobId, text: "second\nnewest", seq: 2 },
		]);

		report("final before completion");
		job.release();
		await manager.waitForAll();
		vi.advanceTimersByTime(1_000);
		expect(recorder.seen).toEqual([
			{ jobId: job.jobId, text: "first", seq: 1 },
			{ jobId: job.jobId, text: "second\nnewest", seq: 2 },
			{ jobId: job.jobId, text: "final before completion", seq: 3 },
		]);
	});

	test("routes ambient events to the owning queue while idle and respects wait/ack suppression", async () => {
		const manager = new AsyncJobManager({});
		const mine = recordingSink();
		const other = recordingSink();
		manager.registerProgressSink("Main", mine.sink);
		manager.registerProgressSink("Other", other.sink);
		const job = heldJob(manager);
		const report = await job.report;

		report("idle");
		expect(mine.seen.map(item => item.text)).toEqual(["idle"]);
		expect(other.seen).toEqual([]);

		manager.watchJobs([job.jobId]);
		report("watched");
		expect(mine.seen).toHaveLength(1);
		manager.unwatchJobs([job.jobId]);
		manager.acknowledgeDeliveries([job.jobId]);
		report("acknowledged");
		expect(mine.seen).toHaveLength(1);

		job.release();
		await manager.waitForAll();
	});

	test("delivers wake progress to an idle owner", async () => {
		const manager = new AsyncJobManager({});
		const recorder = recordingSink();
		manager.registerProgressSink("Main", recorder.sink);
		const job = heldJob(manager, "Main", "wake");
		const report = await job.report;

		report("push while idle");
		expect(recorder.seen).toEqual([{ jobId: job.jobId, text: "push while idle", seq: 1 }]);

		job.release();
		await manager.waitForAll();
	});

	test("waits for asynchronous final progress delivery before delivering completion", async () => {
		const start = Promise.withResolvers<void>();
		const progressStarted = Promise.withResolvers<void>();
		const releaseProgress = Promise.withResolvers<void>();
		const order: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerProgressSink("Main", {
			deliver: async () => {
				order.push("progress:start");
				progressStarted.resolve();
				await releaseProgress.promise;
				order.push("progress:end");
			},
		});
		manager.registerDeliverySink("Main", () => {
			order.push("completion");
		});
		const jobId = manager.register(
			"bash",
			"ordered",
			async ({ reportAgentProgress }) => {
				await start.promise;
				reportAgentProgress("final progress");
				return "done";
			},
			{ ownerId: "Main", progressDelivery: "wake" },
		);

		start.resolve();
		await progressStarted.promise;
		expect(manager.getJob(jobId)?.status).toBe("running");
		expect(order).toEqual(["progress:start"]);

		releaseProgress.resolve();
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });
		expect(order).toEqual(["progress:start", "progress:end", "completion"]);
	});

	test("sink failures are best-effort and do not block completion", async () => {
		const completions: string[] = [];
		const manager = new AsyncJobManager({});
		manager.registerProgressSink("Main", {
			deliver: async () => {
				throw new Error("sink failed");
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});

		const jobId = manager.register(
			"bash",
			"failure",
			async ({ reportAgentProgress }) => {
				reportAgentProgress("tick");
				return "complete";
			},
			{ ownerId: "Main", progressDelivery: "ambient" },
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(completions).toEqual(["complete"]);
	});
});
