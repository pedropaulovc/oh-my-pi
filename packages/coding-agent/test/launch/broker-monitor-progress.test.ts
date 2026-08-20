// Integration test — real timers are required because this drives the actual broker and child process.
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { setProcessName, TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import {
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonMonitorNotification,
} from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

async function waitForOutputCount(notifications: DaemonMonitorNotification[], count: number): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (notifications.filter(notification => notification.event === "daemon-output").length >= count) return;
		await Bun.sleep(10);
	}
	throw new Error(`Expected ${count} output notifications`);
}

describe("daemon broker live output monitoring", () => {
	it("captures immediate output, joins fragmented lines, flushes the final partial, then reports terminal state", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("IMMEDIATE\\n");
process.stdin.once("data", () => {
	process.stdout.write("par");
	process.stdout.write("tial\\n\\n");
	process.stdout.write("final");
	process.exit(0);
});
`,
		);

		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);

		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const firstEntered = Promise.withResolvers<void>();
		const releaseFirst = Promise.withResolvers<void>();
		const entered: string[] = [];
		const unregister = client.onOutput?.(
			{ id: "monitor-1", name: "watched", owner: "owner-1" },
			async notification => {
				entered.push(
					notification.event === "daemon-output"
						? `${notification.event}:${notification.seq}`
						: notification.event,
				);
				if (notification.event === "daemon-output" && notification.seq === 1) {
					firstEntered.resolve();
					await releaseFirst.promise;
				}
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			},
		);
		if (!unregister) throw new Error("Expected output monitoring support");

		try {
			// This ping publishes the subscription before start, closing the immediate-output race.
			const ping = await client.request({ op: "ping" });
			if (ping.op !== "ping") throw new Error("unexpected ping result");
			expect(ping.capabilities).toContain("output-monitor-v1");
			const started = await client.request({
				op: "start",
				owner: "owner-1",
				spec: {
					name: "watched",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await firstEntered.promise;
			await client.request({ op: "send", name: "watched", data: "finish\n" });
			await client.request({ op: "wait", name: "watched", for: "exit", timeoutMs: 5_000 });
			await Bun.sleep(10);
			expect(entered).toEqual(["daemon-output:1"]);
			releaseFirst.resolve();
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			expect(output.map(notification => notification.text)).toEqual(["IMMEDIATE", "partial\nfinal"]);
			expect(output.map(notification => notification.rawText ?? "").join("")).toBe("IMMEDIATE\npartial\n\nfinal");
			expect(output.map(notification => notification.truncated)).toEqual([false, false]);
			expect(output.map(notification => notification.seq)).toEqual([1, 2]);
			expect(notifications.at(-1)).toMatchObject({
				event: "daemon-monitor-completed",
				daemon: { name: "watched", state: "exited", exitCode: 0 },
			});
			expect(entered).toEqual(["daemon-output:1", "daemon-output:2", "daemon-monitor-completed"]);
		} finally {
			releaseFirst.resolve();
			unregister();
			await client.request({ op: "stop", name: "watched", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("starts an attached monitor at the current output boundary", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-attach-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("BEFORE_ATTACH\\n");
process.stdin.once("data", () => {
	process.stdout.write("AFTER_ATTACH\\n");
	process.exit(0);
});
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		let unregister: (() => void) | undefined;
		try {
			const started = await client.request({
				op: "start",
				spec: {
					name: "attach",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await client.request({
				op: "logs",
				name: "attach",
				lines: 20,
				head: false,
				follow: true,
				cursor: 0,
				timeoutMs: 5_000,
			});
			unregister = client.onOutput?.({ id: "attach-monitor", name: "attach", owner: "owner" }, notification => {
				notifications.push(notification);
				if (notification.event === "daemon-monitor-completed") completed.resolve();
			});
			if (!unregister) throw new Error("Expected output monitoring support");
			await client.request({ op: "ping" });
			await client.request({ op: "send", name: "attach", data: "finish\n" });
			await completed.promise;

			const output = notifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["AFTER_ATTACH"]);
		} finally {
			unregister?.();
			await client.request({ op: "stop", name: "attach", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);

	it("keeps one monitor across an explicit process restart", async () => {
		using tempDir = TempDir.createSync("@omp-launch-monitor-restart-");
		const projectDir = path.join(tempDir.path(), "project");
		const runtimeDir = path.join(tempDir.path(), "runtime");
		await fs.mkdir(projectDir);
		const scriptPath = path.join(projectDir, "service.ts");
		await Bun.write(
			scriptPath,
			`process.stdin.setEncoding("utf8");
process.stdin.resume();
process.stdout.write("GENERATION_STARTED\\n");
`,
		);
		const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
		const previousTitle = process.title;
		const broker = startBroker(projectDir, runtimeDir);
		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.({ id: "restart-monitor", name: "restart", owner: "owner" }, notification => {
			notifications.push(notification);
			if (notification.event === "daemon-monitor-completed") completed.resolve();
		});
		if (!unregister) throw new Error("Expected output monitoring support");
		try {
			await client.request({ op: "ping" });
			const started = await client.request({
				op: "start",
				spec: {
					name: "restart",
					application: process.execPath,
					args: [scriptPath],
					env: {},
					cwd: projectDir,
					pty: false,
					restart: "no",
					persist: false,
					detached: false,
				},
			});
			if (started.op !== "start") throw new Error("unexpected start result");
			await waitForOutputCount(notifications, 1);
			await client.request({ op: "restart", name: "restart" });
			await waitForOutputCount(notifications, 2);
			expect(notifications.some(notification => notification.event === "daemon-monitor-completed")).toBe(false);

			await client.request({ op: "stop", name: "restart", timeoutMs: 2_000 });
			await completed.promise;
			const output = notifications.filter(notification => notification.event === "daemon-output");
			expect(output.map(notification => notification.text)).toEqual(["GENERATION_STARTED", "GENERATION_STARTED"]);
			expect(output.map(notification => notification.seq)).toEqual([1, 2]);
			expect(notifications.at(-1)?.event).toBe("daemon-monitor-completed");
		} finally {
			unregister();
			await client.request({ op: "stop", name: "restart", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);
});
