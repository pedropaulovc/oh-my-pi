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

function makeSession(manager: AsyncJobManager): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionId: () => "progress-test",
		getSessionFile: () => null,
		settings: {
			get: (key: string) => SETTINGS[key],
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
	test("describes lossless batched progress delivery", () => {
		const manager = new AsyncJobManager({});
		const tool = new BashTool(makeSession(manager));

		expect(tool.description).toContain("retains every complete non-empty merged stdout/stderr line");
		expect(tool.description).toContain("batches pushes to at most once per second");
		expect(tool.description).toContain("wakes the agent when idle");
		expect(tool.description).toContain("Lines emitted while busy arrive together");
		expect(tool.description).toContain('`progress: "ambient"` waits for an active turn and never wakes');
		expect(tool.description).toContain("Completion is separate");
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
});
