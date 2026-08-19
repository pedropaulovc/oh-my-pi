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
		const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
		const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
		const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
		const previousTitle = process.title;
		process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
		process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
		process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
		const broker = startDaemonBrokerFromEnvironment();
		restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
		restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
		restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);

		const notifications: DaemonMonitorNotification[] = [];
		const completed = Promise.withResolvers<void>();
		const unregister = client.onOutput?.({ id: "monitor-1", name: "watched", owner: "owner-1" }, notification => {
			notifications.push(notification);
			if (notification.event === "daemon-monitor-completed") completed.resolve();
		});
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
			await client.request({ op: "send", name: "watched", data: "finish\n" });
			await completed.promise;

			const output = notifications.filter(
				(notification): notification is Extract<DaemonMonitorNotification, { event: "daemon-output" }> =>
					notification.event === "daemon-output",
			);
			expect(output.map(notification => notification.text)).toEqual(["IMMEDIATE", "partial\nfinal"]);
			expect(output.map(notification => notification.seq)).toEqual([1, 2]);
			expect(notifications.at(-1)).toMatchObject({
				event: "daemon-monitor-completed",
				daemon: { name: "watched", state: "exited", exitCode: 0 },
			});
		} finally {
			unregister();
			await client.request({ op: "stop", name: "watched", timeoutMs: 2_000 }).catch(() => undefined);
			await client.request({ op: "shutdown" }).catch(() => undefined);
			client.close();
			await broker;
			setProcessName(previousTitle);
		}
	}, 20_000);
});
