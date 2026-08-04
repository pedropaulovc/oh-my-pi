import { describe, expect, test } from "bun:test";
import { type AsyncJob, AsyncJobManager, type AsyncJobProgressSink } from "@oh-my-pi/pi-coding-agent/async/job-manager";

interface Recorder {
	sink: AsyncJobProgressSink;
	texts: () => string[];
	setActive: (value: boolean) => void;
}

function recorder(options: { active?: boolean; throwOnDeliver?: boolean } = {}): Recorder {
	const seen: string[] = [];
	let active = options.active ?? true;
	return {
		sink: {
			isActive: () => active,
			deliver: (_jobId: string, text: string, _job: AsyncJob) => {
				if (options.throwOnDeliver) throw new Error("sink exploded");
				seen.push(text);
			},
		},
		texts: () => seen.slice(),
		setActive: value => {
			active = value;
		},
	};
}

/** Park a job until `release` resolves so policy changes can be made mid-run. */
function heldJob(manager: AsyncJobManager, ownerId: string, policy?: { wake?: boolean; intervalMs?: number }) {
	const gate = Promise.withResolvers<void>();
	const started = Promise.withResolvers<(text: string) => void>();
	const jobId = manager.register(
		"bash",
		"held",
		async ({ reportAgentProgress }) => {
			started.resolve(reportAgentProgress);
			await gate.promise;
			return "final output";
		},
		{ ownerId, progressPolicy: policy },
	);
	return { jobId, started: started.promise, release: () => gate.resolve() };
}

describe("AsyncJobManager agent-facing progress", () => {
	test("stays silent when no policy is armed", async () => {
		const progress = recorder();
		const completions: string[] = [];
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", progress.sink);
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});

		manager.register(
			"bash",
			"quiet",
			async ({ reportAgentProgress }) => {
				for (let i = 0; i < 5; i++) reportAgentProgress(`ignored ${i}`);
				return "done";
			},
			{ ownerId: "Main" },
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(progress.texts()).toEqual([]);
		expect(completions).toEqual(["done"]);
	});

	test("coalesces a burst to the newest text and flushes the tail on the trailing edge", async () => {
		const progress = recorder();
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", progress.sink);

		const job = heldJob(manager, "Main", { intervalMs: 10_000 });
		const report = await job.started;

		// First report passes immediately (no prior emission), the rest land inside
		// the window and must collapse into one pending update.
		report("first");
		for (let i = 0; i < 20; i++) report(`burst ${i}`);
		expect(progress.texts()).toEqual(["first"]);

		job.release();
		await manager.waitForAll();

		// The job settled, so the buffered burst is dropped rather than delivered
		// after the result — the completion carries the real output.
		expect(progress.texts()).toEqual(["first"]);
	});

	test("emits again once the rate window elapses", async () => {
		const progress = recorder();
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", progress.sink);

		const job = heldJob(manager, "Main", { intervalMs: 20 });
		const report = await job.started;

		report("one");
		report("two");
		await Bun.sleep(60);
		expect(progress.texts()).toEqual(["one", "two"]);

		job.release();
		await manager.waitForAll();
	});

	test("a hub wait watching the job suppresses its progress", async () => {
		const progress = recorder();
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", progress.sink);

		const job = heldJob(manager, "Main", { intervalMs: 0 });
		const report = await job.started;

		manager.watchJobs([job.jobId]);
		report("suppressed");
		expect(progress.texts()).toEqual([]);

		manager.unwatchJobs([job.jobId]);
		report("visible again");
		expect(progress.texts()).toEqual(["visible again"]);

		job.release();
		await manager.waitForAll();
	});

	test("acknowledged deliveries suppress progress too", async () => {
		const progress = recorder();
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", progress.sink);

		const job = heldJob(manager, "Main", { intervalMs: 0 });
		const report = await job.started;

		manager.acknowledgeDeliveries([job.jobId]);
		report("after ack");
		expect(progress.texts()).toEqual([]);

		job.release();
		await manager.waitForAll();
	});

	test("setProgressPolicy arms, retunes, and stops without touching the job", async () => {
		const progress = recorder();
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", progress.sink);

		// Starts with no policy: reports are dropped.
		const job = heldJob(manager, "Main");
		const report = await job.started;
		report("before arming");
		expect(progress.texts()).toEqual([]);

		expect(manager.setProgressPolicy(job.jobId, { intervalMs: 0 })).toBe(true);
		report("after arming");
		expect(progress.texts()).toEqual(["after arming"]);

		// Retune to wake: the policy the sink reads is the live one.
		manager.setProgressPolicy(job.jobId, { intervalMs: 0, wake: true });
		expect(manager.getProgressPolicy(job.jobId)?.wake).toBe(true);

		// Stop: still running, but silent.
		expect(manager.setProgressPolicy(job.jobId, undefined)).toBe(true);
		report("after stopping");
		expect(progress.texts()).toEqual(["after arming"]);
		expect(manager.getJob(job.jobId)?.status).toBe("running");

		job.release();
		await manager.waitForAll();
		expect(manager.getJob(job.jobId)?.status).toBe("completed");
	});

	test("setProgressPolicy is owner-scoped and rejects settled jobs", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", recorder().sink);

		const job = heldJob(manager, "Main", { intervalMs: 0 });
		await job.started;

		expect(manager.setProgressPolicy(job.jobId, { intervalMs: 0 }, { ownerId: "Other" })).toBe(false);
		expect(manager.setProgressPolicy(job.jobId, { intervalMs: 0 }, { ownerId: "Main" })).toBe(true);
		expect(manager.getProgressPolicy(job.jobId, { ownerId: "Other" })).toBeUndefined();

		job.release();
		await manager.waitForAll();

		expect(manager.setProgressPolicy(job.jobId, { intervalMs: 0 })).toBe(false);
	});

	test("ambient progress is skipped while the session is idle, wake progress is not", async () => {
		const ambient = recorder({ active: false });
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", ambient.sink);

		const job = heldJob(manager, "Main", { intervalMs: 0 });
		const report = await job.started;

		report("while idle");
		expect(ambient.texts()).toEqual([]);

		ambient.setActive(true);
		report("while streaming");
		expect(ambient.texts()).toEqual(["while streaming"]);

		// A wake policy ignores the idle gate entirely.
		ambient.setActive(false);
		manager.setProgressPolicy(job.jobId, { intervalMs: 0, wake: true });
		report("wake while idle");
		expect(ambient.texts()).toEqual(["while streaming", "wake while idle"]);

		job.release();
		await manager.waitForAll();
	});

	test("a throwing progress sink neither fails the job nor blocks completion delivery", async () => {
		const completions: string[] = [];
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", recorder({ throwOnDeliver: true }).sink);
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});

		const jobId = manager.register(
			"bash",
			"explodes",
			async ({ reportAgentProgress }) => {
				reportAgentProgress("boom");
				return "still finished";
			},
			{ ownerId: "Main", progressPolicy: { intervalMs: 0 } },
		);

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 2_000 });

		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(completions).toEqual(["still finished"]);
	});

	test("progress for one owner never reaches another owner's sink", async () => {
		const mine = recorder();
		const theirs = recorder();
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", mine.sink);
		manager.registerProgressSink("Other", theirs.sink);

		const job = heldJob(manager, "Main", { intervalMs: 0 });
		const report = await job.started;
		report("mine only");

		expect(mine.texts()).toEqual(["mine only"]);
		expect(theirs.texts()).toEqual([]);

		job.release();
		await manager.waitForAll();
	});

	test("progressEmitCount tracks emissions for the wake reminder", async () => {
		const progress = recorder();
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		manager.registerProgressSink("Main", progress.sink);

		const job = heldJob(manager, "Main", { intervalMs: 0 });
		const report = await job.started;

		expect(manager.progressEmitCount(job.jobId)).toBe(0);
		report("a");
		report("b");
		expect(manager.progressEmitCount(job.jobId)).toBe(2);
		expect(manager.progressSeq(job.jobId)).toBe(2);

		job.release();
		await manager.waitForAll();
	});
});
