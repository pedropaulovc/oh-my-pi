import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { type CoordinationDetails, HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

function makeSession(manager: AsyncJobManager): ToolSession {
	const values: Record<string, unknown> = {
		"async.pollWaitDuration": "5s",
		"async.progress.minIntervalMs": 1_000,
		"launch.enabled": false,
	};
	return {
		cwd: process.cwd(),
		hasUI: false,
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionId: () => "test-session",
		settings: { get: (key: string) => values[key] },
	} as unknown as ToolSession;
}

/** A job parked until released, so its policy can be changed while running. */
function heldJob(manager: AsyncJobManager, ownerId: string) {
	const gate = Promise.withResolvers<void>();
	const jobId = manager.register(
		"bash",
		"held",
		async () => {
			await gate.promise;
			return "done";
		},
		{ ownerId },
	);
	return { jobId, release: () => gate.resolve() };
}

function details(result: { details?: unknown }): CoordinationDetails {
	return result.details as CoordinationDetails;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

describe("hub op:monitor", () => {
	test("arms a running job, then reports the live policy", async () => {
		const manager = new AsyncJobManager({});
		const tool = new HubTool(makeSession(manager));
		const job = heldJob(manager, "Main");

		const armed = await tool.execute("call-arm", {
			op: "monitor",
			ids: [job.jobId],
			progress: { every: 5, match: "^error", wake: true },
		});
		expect(details(armed).monitors?.[0]).toMatchObject({ id: job.jobId, status: "armed" });
		expect(manager.getProgressPolicy(job.jobId)).toMatchObject({ wake: true, intervalMs: 5_000 });

		const reported = await tool.execute("call-report", { op: "monitor" });
		const text = resultText(reported);
		expect(text).toContain(job.jobId);
		expect(text).toContain("every 5s");
		expect(text).toContain("match /^error/");
		expect(text).toContain("wakes when idle");

		job.release();
		await manager.waitForAll();
	});

	test("omitting progress stops reporting but leaves the job running", async () => {
		const manager = new AsyncJobManager({});
		const tool = new HubTool(makeSession(manager));
		const job = heldJob(manager, "Main");

		await tool.execute("call-arm", { op: "monitor", ids: [job.jobId], progress: { every: 5 } });
		expect(manager.getProgressPolicy(job.jobId)).toBeDefined();

		const stopped = await tool.execute("call-stop", { op: "monitor", ids: [job.jobId] });
		expect(details(stopped).monitors?.[0]).toMatchObject({ id: job.jobId, status: "stopped" });
		expect(manager.getProgressPolicy(job.jobId)).toBeUndefined();
		expect(manager.getJob(job.jobId)?.status).toBe("running");

		job.release();
		await manager.waitForAll();
	});

	test("raises a below-floor cadence to the configured minimum", async () => {
		const manager = new AsyncJobManager({});
		const tool = new HubTool(makeSession(manager));
		const job = heldJob(manager, "Main");

		await tool.execute("call-floor", { op: "monitor", ids: [job.jobId], progress: { every: 0.05 } });
		expect(manager.getProgressPolicy(job.jobId)?.intervalMs).toBe(1_000);

		job.release();
		await manager.waitForAll();
	});

	test("reports unknown ids instead of hanging or throwing", async () => {
		const manager = new AsyncJobManager({});
		const tool = new HubTool(makeSession(manager));

		const result = await tool.execute("call-missing", {
			op: "monitor",
			ids: ["bg_nope"],
			progress: { every: 5 },
		});
		expect(details(result).monitors?.[0]).toMatchObject({ id: "bg_nope", status: "not_found" });
		expect(resultText(result)).toContain("history://bg_nope");
	});

	test("refuses an invalid regex and a progress block with no trigger", async () => {
		const manager = new AsyncJobManager({});
		const tool = new HubTool(makeSession(manager));
		const job = heldJob(manager, "Main");

		const badRegex = await tool.execute("call-bad", {
			op: "monitor",
			ids: [job.jobId],
			progress: { match: "([unclosed" },
		});
		expect(badRegex.isError).toBe(true);
		expect(resultText(badRegex)).toContain("not a valid regular expression");

		const noTrigger = await tool.execute("call-empty", { op: "monitor", ids: [job.jobId], progress: { wake: true } });
		expect(noTrigger.isError).toBe(true);
		expect(resultText(noTrigger)).toContain("needs `every` or `match`");
		expect(manager.getProgressPolicy(job.jobId)).toBeUndefined();

		job.release();
		await manager.waitForAll();
	});

	test("cannot retune another agent's job", async () => {
		const manager = new AsyncJobManager({});
		const tool = new HubTool(makeSession(manager));
		const job = heldJob(manager, "Someone-Else");

		const result = await tool.execute("call-cross", {
			op: "monitor",
			ids: [job.jobId],
			progress: { every: 5 },
		});
		expect(details(result).monitors?.[0]?.status).toBe("not_found");
		expect(manager.getProgressPolicy(job.jobId)).toBeUndefined();

		job.release();
		await manager.waitForAll();
	});

	test("refuses to monitor a job that already settled", async () => {
		const manager = new AsyncJobManager({});
		const tool = new HubTool(makeSession(manager));
		const jobId = manager.register("bash", "quick", async () => "done", { ownerId: "Main" });
		await manager.waitForAll();

		const result = await tool.execute("call-settled", { op: "monitor", ids: [jobId], progress: { every: 5 } });
		expect(details(result).monitors?.[0]?.status).toBe("already_completed");
	});
});
