import { describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

const SETTINGS: Record<string, unknown> = {
	"async.enabled": true,
	"bash.autoBackground.enabled": false,
	"bash.autoBackground.thresholdMs": 60_000,
	"bashInterceptor.enabled": false,
	"astGrep.enabled": false,
	"astEdit.enabled": false,
	"grep.enabled": false,
	"glob.enabled": false,
};

function makeSession(manager: AsyncJobManager, overrides: Record<string, unknown> = {}): ToolSession {
	const settings = { ...SETTINGS, ...overrides };
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionId: () => "progress-test",
		getSessionFile: () => null,
		settings: {
			get: (key: string) => settings[key],
			getBashInterceptorRules: () => [],
			getShellConfig: () => ({}),
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

function collectProgress(manager: AsyncJobManager): string[] {
	const seen: string[] = [];
	manager.registerDeliverySink("Main", () => {});
	manager.registerProgressSink("Main", {
		deliver: (_jobId, text) => {
			seen.push(text);
		},
	});
	return seen;
}

describe("bash progress parameter", () => {
	test("describes bounded drop-free progress delivery", () => {
		const manager = new AsyncJobManager({});
		const tool = new BashTool(makeSession(manager));

		expect(tool.description).toContain('`async: "auto"` keeps quick work inline and backgrounds slow work');
		expect(tool.description).toContain("`async: true` starts background immediately");
		expect(tool.description).toContain("non-empty merged lines");
		expect(tool.description).toContain("final 4,000 chars");
		expect(tool.description).toContain("drop-free batches ≤1/s");
		expect(tool.description).toContain("wakes idle");
		expect(tool.description).toContain("Ambient waits for an active turn and never wakes");
		expect(tool.description).toContain("completion is separate");
		expect(tool.description).toContain("NEVER wait for progress or to keep the turn alive");
		expect(tool.description).toContain("use async, then end the turn");
	});

	test("defaults off", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("default-off", { command: "printf 'one\\ntwo\\n'", async: true });
		await manager.waitForAll();

		expect(seen).toEqual([]);
	});

	test("reports complete non-empty lines and flushes the final partial line", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("complete-lines", {
			command: "printf par; sleep 0.1; printf 'tial\\n\\n'",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();
		await tool.execute("final-partial", {
			command: "printf final",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();

		expect(seen).toEqual(["partial", "final"]);
	}, 10_000);

	test("bounds an unterminated output line before reporting it", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("bounded-line", {
			command: "printf '%05000d' 0",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toHaveLength(4_000);
		expect(seen[0]).toBe("0".repeat(4_000));
	});

	test("rejects progress for a foreground command", async () => {
		const manager = new AsyncJobManager({});
		const tool = new BashTool(makeSession(manager));

		await expect(tool.execute("foreground", { command: "echo no", progress: "wake" })).rejects.toThrow(
			/requires `async: true`/,
		);
	});

	test("keeps a quick auto command inline without progress or completion delivery", async () => {
		const manager = new AsyncJobManager({});
		const progress = collectProgress(manager);
		const completions: string[] = [];
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const tool = new BashTool(makeSession(manager, { "bash.autoBackground.thresholdMs": 2_000 }));

		const result = await tool.execute("auto-inline", {
			command: "printf 'quick-result\\n'",
			async: "auto",
			progress: "wake",
		});
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(result.details?.async).toBeUndefined();
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("quick-result") }),
		);
		expect(progress).toEqual([]);
		expect(completions).toEqual([]);
		await manager.dispose();
	});

	test("promotes a slow auto command and delivers only later lines before completion", async () => {
		const manager = new AsyncJobManager({});
		const events: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				events.push(`progress:${text}`);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			events.push(`completion:${text}`);
		});
		const tool = new BashTool(makeSession(manager, { "bash.autoBackground.thresholdMs": 20 }));

		const result = await tool.execute("auto-promote", {
			command: "printf 'before-promotion\\n'; sleep 0.08; printf 'after-promotion\\n'",
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("before-promotion") }),
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(events[0]).toBe("progress:after-promotion");
		expect(events[1]).toContain("completion:");
		expect(events[1]).toContain("before-promotion");
		expect(events[1]).toContain("after-promotion");
		expect(events.join("\n").match(/progress:before-promotion/g)).toBeNull();
		await manager.dispose();
	}, 10_000);
});
