import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { listAllSessionFiles, listSessionFiles } from "@oh-my-pi/omp-stats/parser";
import { getSessionsDir } from "@oh-my-pi/pi-utils";
import { installStatsTestIsolation } from "./helpers/temp-agent";

installStatsTestIsolation("@pi-stats-file-order-");

/**
 * Sync's fork dedupe is first-write-wins across a lineage, so the order these
 * helpers return decides which session file *owns* a deduplicated provider
 * request. `fs.readdir` returns filesystem order (hash order on ext4), which
 * made that ownership arbitrary — a fork could claim a turn made in its parent.
 */
describe("session file listing order", () => {
	// Deliberately created in an order that does not match their sorted order,
	// so a listing that just echoes creation/directory order fails here.
	const names = ["03_c.jsonl", "01_a.jsonl", "05_e.jsonl", "02_b.jsonl", "04_d.jsonl"];

	async function seedFolder(folder: string): Promise<string> {
		const dir = path.join(getSessionsDir(), folder);
		await fs.mkdir(dir, { recursive: true });
		for (const name of names) {
			await fs.writeFile(path.join(dir, name), "");
		}
		return dir;
	}

	it("returns a folder's session files sorted by path", async () => {
		const dir = await seedFolder("--tmp--order-one");

		const files = await listSessionFiles(dir);

		expect(files).toEqual([...files].sort());
		expect(files.map(file => path.basename(file))).toEqual([...names].sort());
	});

	it("returns a stable global order across folders", async () => {
		await seedFolder("--tmp--order-alpha");
		await seedFolder("--tmp--order-beta");

		const first = await listAllSessionFiles();
		const second = await listAllSessionFiles();

		expect(first).toEqual([...first].sort());
		expect(second).toEqual(first);
	});
});
