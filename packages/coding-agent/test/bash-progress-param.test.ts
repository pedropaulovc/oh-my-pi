import { describe, expect, it } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const SETTINGS: Record<string, unknown> = {
	"async.enabled": true,
	"async.progress.minIntervalMs": 0,
	"async.progress.maxLines": 20,
	"bash.autoBackground.enabled": false,
	"bash.autoBackground.thresholdMs": 60_000,
	"bashInterceptor.enabled": false,
	"astGrep.enabled": false,
	"astEdit.enabled": false,
	"grep.enabled": false,
	"glob.enabled": false,
};

function makeSession(manager: AsyncJobManager, overrides: Record<string, unknown> = {}): ToolSession {
	const values = { ...SETTINGS, ...overrides };
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionId: () => "test-session",
		getSessionFile: () => null,
		settings: {
			get: (key: string) => values[key],
			getBashInterceptorRules: () => [],
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

/** Collect agent-facing progress for a manager, with the session always "active". */
function collectProgress(manager: AsyncJobManager): () => string[] {
	const seen: string[] = [];
	manager.registerProgressSink("Main", {
		isActive: () => true,
		deliver: (_jobId, text) => {
			seen.push(text);
		},
	});
	return () => seen.slice();
}

describe("bash progress parameter", () => {
	it("reports the matching line and nothing else", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		const progress = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		const start = await tool.execute("call-match", {
			command: "echo alpha; echo TRIGGER here; echo omega",
			async: true,
			progress: { match: "^TRIGGER" },
		});
		const jobId = start.details?.async?.jobId;
		expect(jobId).toBeTruthy();

		await manager.waitForAll();
		expect(progress()).toEqual(["TRIGGER here"]);
	});

	it("stopOnMatch ends the command but still delivers the partial output", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		const progress = collectProgress(manager);
		const delivered: string[] = [];
		manager.registerDeliverySink("Main", (_jobId, text) => {
			delivered.push(text);
		});
		const tool = new BashTool(makeSession(manager));

		const start = await tool.execute("call-stop", {
			command: 'echo first; echo STOP; sleep 30; echo "never printed"',
			async: true,
			timeout: 0,
			progress: { match: "^STOP", stopOnMatch: true },
		});
		const jobId = start.details?.async?.jobId ?? "";

		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 5_000 });

		expect(progress()).toEqual(["STOP"]);
		// The job must NOT be `cancelled`: the manager skips delivery for cancelled
		// jobs, which would leave the agent with the trigger and no output.
		expect(manager.getJob(jobId)?.status).toBe("completed");
		expect(delivered).toHaveLength(1);
		expect(delivered[0]).toContain("first");
		expect(delivered[0]).toContain("Stopped early: progress match fired.");
		// It really stopped — the post-sleep line never ran.
		expect(delivered[0]).not.toContain("never printed");
	}, 20_000);

	it("carries the newest lines on the `every` cadence, capped by `lines`", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		const progress = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("call-every", {
			command: 'for i in 1 2 3 4 5; do echo "step $i"; sleep 0.05; done',
			async: true,
			progress: { every: 0.01, lines: 2 },
		});

		await manager.waitForAll();
		const updates = progress();
		expect(updates.length).toBeGreaterThan(0);
		for (const update of updates) {
			expect(update.split("\n").length).toBeLessThanOrEqual(2);
			for (const line of update.split("\n")) expect(line).toMatch(/^step \d$/);
		}
		// The final state of the command is visible without waiting for completion.
		expect(updates.join("\n")).toContain("step 5");
	}, 20_000);

	it("rejects an invalid match regex", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		const tool = new BashTool(makeSession(manager));

		await expect(
			tool.execute("call-bad-regex", { command: "echo hi", async: true, progress: { match: "([unclosed" } }),
		).rejects.toThrow(/not a valid regular expression/);
	});

	it("rejects a progress block with no trigger", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		const tool = new BashTool(makeSession(manager));

		await expect(
			tool.execute("call-no-trigger", { command: "echo hi", async: true, progress: { wake: true } }),
		).rejects.toThrow(/requires `every`.*or `match`/);
	});

	it("rejects progress on a foreground command instead of silently ignoring it", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		const tool = new BashTool(makeSession(manager));

		await expect(tool.execute("call-foreground", { command: "echo hi", progress: { every: 1 } })).rejects.toThrow(
			/requires `async: true`/,
		);
	});

	it("clamps a below-floor cadence and says so in the result", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 5_000 });
		const tool = new BashTool(makeSession(manager, { "async.progress.minIntervalMs": 5_000 }));

		const start = await tool.execute("call-clamp", {
			command: "echo hi",
			async: true,
			progress: { every: 0.1, lines: 999 },
		});

		const text = start.content.find(block => block.type === "text")?.text ?? "";
		expect(text).toContain("progress.every raised to 5s");
		expect(text).toContain("progress.lines lowered to 20");
		await manager.waitForAll();
	});

	it("stays silent with no progress parameter", async () => {
		const manager = new AsyncJobManager({ progressMinIntervalMs: 0 });
		const progress = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("call-silent", { command: "echo one; echo two", async: true });

		await manager.waitForAll();
		expect(progress()).toEqual([]);
	});
});
