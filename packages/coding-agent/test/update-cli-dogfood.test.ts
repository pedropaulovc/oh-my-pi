import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	type DogfoodUpdateSource,
	getBinaryName,
	getLatestDogfoodRelease,
	resolveDogfoodBinaryPath,
	resolveDogfoodRelease,
	resolveReleaseBinaryAsset,
	runDogfoodUpdateCommand,
	updateViaBinaryAt,
} from "@oh-my-pi/pi-coding-agent/cli/update-cli";
import { CliUsageError } from "@oh-my-pi/pi-coding-agent/cli/usage-error";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FORK = "pedropaulovc/oh-my-pi";
const UPSTREAM = "can1357/oh-my-pi";
const SOURCE: DogfoodUpdateSource = { repository: FORK, appName: "omp-dogfood" };
const VERSION = "999.0.0-dogfood.3";
const TAG = `v${VERSION}`;

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "omp-dogfood-update-test-")));
	tempDirs.push(dir);
	return dir;
}

/** Run `fn` with `process.platform` reporting win32, to drive the Windows asset suffix. */
function withWin32<T>(fn: () => T): T {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!platformDescriptor) throw new Error("process.platform descriptor missing");
	Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", platformDescriptor);
	}
}

function latestRelease(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		tag_name: TAG,
		draft: false,
		prerelease: false,
		html_url: `https://github.com/${FORK}/releases/tag/${TAG}`,
		...overrides,
	};
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

describe("dogfood release discovery", () => {
	it("accepts an exact v<semver>-dogfood.<n> release published by the fork", () => {
		expect(resolveDogfoodRelease(latestRelease(), FORK)).toEqual({
			tag: TAG,
			version: VERSION,
			dist: "binary",
			repository: FORK,
		});
	});

	it("rejects every tag that is not a dogfood release of this fork", () => {
		// An upstream release reachable from the fork (tags are inherited by a
		// fork) must never be installed over a dogfood build: its assets are
		// vanilla `omp`, and its version line would fight the dogfood counter.
		expect(() => resolveDogfoodRelease(latestRelease({ tag_name: "v999.0.0" }), FORK)).toThrow(
			"is not a omp-dogfood release",
		);
		expect(() => resolveDogfoodRelease(latestRelease({ tag_name: "v999.0.0-canary.1" }), FORK)).toThrow(
			"is not a omp-dogfood release",
		);
		expect(() => resolveDogfoodRelease(latestRelease({ tag_name: "999.0.0-dogfood.3" }), FORK)).toThrow(
			"is not a omp-dogfood release",
		);
		expect(() => resolveDogfoodRelease(latestRelease({ tag_name: `${TAG}-rc` }), FORK)).toThrow(
			"is not a omp-dogfood release",
		);
		expect(() => resolveDogfoodRelease(latestRelease({ tag_name: 7 }), FORK)).toThrow("has no tag name");
		expect(() => resolveDogfoodRelease("not-json", FORK)).toThrow("Invalid GitHub release metadata");
	});

	it("rejects unpublished releases and releases hosted by another repository", () => {
		expect(() => resolveDogfoodRelease(latestRelease({ draft: true }), FORK)).toThrow("is a draft");
		expect(() => resolveDogfoodRelease(latestRelease({ prerelease: true }), FORK)).toThrow("is a prerelease");
		// Metadata served from upstream (a misconfigured repository define, a
		// redirected fetch) is refused rather than trusted.
		expect(() =>
			resolveDogfoodRelease(latestRelease({ html_url: `https://github.com/${UPSTREAM}/releases/tag/${TAG}` }), FORK),
		).toThrow(`is not published by ${FORK}`);
		expect(() => resolveDogfoodRelease(latestRelease({ html_url: undefined }), FORK)).toThrow(
			`is not published by ${FORK}`,
		);
	});

	it("selects the latest dogfood release from the fork and never queries npm", async () => {
		const urls: string[] = [];
		const release = await getLatestDogfoodRelease(SOURCE, {
			fetchImpl: async input => {
				urls.push(String(input));
				return new Response(
					JSON.stringify([
						latestRelease({
							tag_name: "v999.0.1",
							html_url: `https://github.com/${FORK}/releases/tag/v999.0.1`,
						}),
						latestRelease({
							tag_name: "v998.0.0-dogfood.9",
							html_url: `https://github.com/${FORK}/releases/tag/v998.0.0-dogfood.9`,
						}),
						latestRelease(),
					]),
				);
			},
			githubToken: "",
		});

		expect(urls).toEqual([`https://api.github.com/repos/${FORK}/releases?per_page=100`]);
		expect(release.version).toBe(VERSION);
	});

	it("sends the optional token as metadata-only authorization", async () => {
		let authorization: string | undefined;
		await getLatestDogfoodRelease(SOURCE, {
			fetchImpl: async (_input, init) => {
				authorization = new Headers(init?.headers).get("authorization") ?? undefined;
				return new Response(JSON.stringify([latestRelease()]));
			},
			githubToken: "fork-token",
		});

		expect(authorization).toBe("Bearer fork-token");
	});
});

describe("dogfood asset naming", () => {
	it("names the dogfood asset without disturbing the official default", () => {
		const arch = process.arch;
		expect(getBinaryName()).toBe(getBinaryName("omp"));
		expect(getBinaryName()).toMatch(/^omp-/);
		expect(getBinaryName("omp-dogfood")).toBe(getBinaryName().replace(/^omp-/, "omp-dogfood-"));
		expect(withWin32(() => getBinaryName("omp-dogfood"))).toBe(`omp-dogfood-windows-${arch}.exe`);
		expect(withWin32(() => getBinaryName())).toBe(`omp-windows-${arch}.exe`);
	});
});

describe("dogfood asset validation", () => {
	const binaryName = "omp-dogfood-linux-x64";
	const content = "dogfood binary";
	const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;

	function assetRelease(repository: string): Record<string, unknown> {
		return {
			tag_name: TAG,
			draft: false,
			prerelease: false,
			assets: [
				{
					name: binaryName,
					state: "uploaded",
					size: Buffer.byteLength(content),
					digest,
					browser_download_url: `https://github.com/${repository}/releases/download/${TAG}/${binaryName}`,
				},
			],
		};
	}

	it("pins the download to the fork's own release asset", () => {
		expect(resolveReleaseBinaryAsset(assetRelease(FORK), TAG, binaryName, { repository: FORK })).toEqual({
			url: `https://github.com/${FORK}/releases/download/${TAG}/${binaryName}`,
			size: Buffer.byteLength(content),
			digest,
		});
	});

	it("refuses an upstream-hosted asset for a dogfood release", () => {
		// Same tag, same digest, wrong host: a dogfood build must never pull a
		// binary from the upstream repository.
		expect(() => resolveReleaseBinaryAsset(assetRelease(UPSTREAM), TAG, binaryName, { repository: FORK })).toThrow(
			"has an unexpected download URL",
		);
	});

	it("keeps the official repository as the default host", () => {
		expect(() => resolveReleaseBinaryAsset(assetRelease(FORK), TAG, binaryName)).toThrow(
			"has an unexpected download URL",
		);
		expect(resolveReleaseBinaryAsset(assetRelease(UPSTREAM), TAG, binaryName).url).toBe(
			`https://github.com/${UPSTREAM}/releases/download/${TAG}/${binaryName}`,
		);
	});
});

describe("dogfood update target selection", () => {
	it("updates the omp-dogfood PATH entry", async () => {
		const dir = await makeTempDir();
		const dogfoodPath = path.join(dir, "omp-dogfood");
		await Bun.write(dogfoodPath, "dogfood binary");

		expect(resolveDogfoodBinaryPath({ which: () => dogfoodPath })).toBe(dogfoodPath);
	});

	it("resolves a symlinked PATH entry to the real dogfood binary", async () => {
		const dir = await makeTempDir();
		const real = path.join(dir, "omp-dogfood-18.1.19");
		const link = path.join(dir, "omp-dogfood");
		await Bun.write(real, "dogfood binary");
		await fs.symlink(real, link);

		expect(resolveDogfoodBinaryPath({ which: () => link })).toBe(real);
	});

	it("refuses to replace the vanilla omp executable", async () => {
		const dir = await makeTempDir();
		const vanilla = path.join(dir, "omp");
		const link = path.join(dir, "omp-dogfood");
		await Bun.write(vanilla, "official binary");
		await fs.symlink(vanilla, link);

		// A dogfood launcher that resolves onto the official install would
		// overwrite it with a fork build on the next update.
		expect(() => resolveDogfoodBinaryPath({ which: () => link })).toThrow("vanilla omp executable");
		expect(() =>
			resolveDogfoodBinaryPath({ which: () => undefined, compiled: true, execPath: "/usr/local/bin/omp" }),
		).toThrow("must not be installed as the vanilla omp executable");
		expect(() =>
			resolveDogfoodBinaryPath({ which: () => undefined, compiled: true, execPath: "/tools/OMP.EXE" }),
		).toThrow("must not be installed as the vanilla omp executable");
		expect(() =>
			resolveDogfoodBinaryPath({
				which: () => "/usr/bin/bun",
				realpath: filePath => filePath,
			}),
		).toThrow("must resolve to a dogfood-named executable");
	});

	it("falls back to the running compiled executable, never to a source runtime", () => {
		expect(resolveDogfoodBinaryPath({ which: () => undefined, compiled: true, execPath: "/opt/omp-dogfood" })).toBe(
			"/opt/omp-dogfood",
		);
		expect(() =>
			resolveDogfoodBinaryPath({ which: () => undefined, compiled: true, execPath: "/opt/not-dogfood" }),
		).toThrow("must use a dogfood-named executable");
		// From source `process.execPath` is bun itself; replacing it would
		// destroy the user's runtime.
		expect(() =>
			resolveDogfoodBinaryPath({ which: () => undefined, compiled: false, execPath: "/usr/bin/bun" }),
		).toThrow("not a compiled omp-dogfood build");
	});
});

describe("dogfood update command", () => {
	const content = `#!/bin/sh\necho omp/${VERSION}\n`;
	const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;

	function makeFetch(binaryName: string, urls: string[]): (input: string | URL | Request) => Promise<Response> {
		const downloadUrl = `https://github.com/${FORK}/releases/download/${TAG}/${binaryName}`;
		return async (input: string | URL | Request): Promise<Response> => {
			const requestUrl = String(input);
			urls.push(requestUrl);
			if (requestUrl === `https://api.github.com/repos/${FORK}/releases?per_page=100`) {
				return new Response(JSON.stringify([latestRelease()]));
			}
			if (requestUrl === `https://api.github.com/repos/${FORK}/releases/tags/${encodeURIComponent(TAG)}`) {
				return new Response(
					JSON.stringify({
						...latestRelease(),
						assets: [
							{
								name: binaryName,
								state: "uploaded",
								size: Buffer.byteLength(content),
								digest,
								browser_download_url: downloadUrl,
							},
						],
					}),
				);
			}
			if (requestUrl === downloadUrl) return new Response(content);
			throw new Error(`Unexpected request: ${requestUrl}`);
		};
	}

	it("rejects update channels as a usage error before any network call", async () => {
		const fetchImpl = (): Promise<Response> => {
			throw new Error("no request expected");
		};

		for (const channel of ["canary", "stable"] as const) {
			await expect(
				runDogfoodUpdateCommand(SOURCE, { force: false, check: false, channel }, { fetchImpl }),
			).rejects.toBeInstanceOf(CliUsageError);
		}
	});

	it("installs the fork's dogfood asset over omp-dogfood and leaves vanilla omp alone", async () => {
		spyOn(console, "log").mockImplementation(() => {});
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp-dogfood");
		const vanillaPath = path.join(dir, "omp");
		await Bun.write(targetPath, "old dogfood binary");
		await Bun.write(vanillaPath, "official binary");
		const urls: string[] = [];

		await runDogfoodUpdateCommand(
			SOURCE,
			{ force: false, check: false },
			{
				fetchImpl: makeFetch(getBinaryName("omp-dogfood"), urls),
				targetPath,
				verifyInstalledVersion: async () => ({ ok: true, actual: VERSION, path: targetPath }),
				validateExistingTarget: false,
			},
		);

		expect(await Bun.file(targetPath).text()).toBe(content);
		expect(await Bun.file(vanillaPath).text()).toBe("official binary");
		expect(urls).toEqual([
			`https://api.github.com/repos/${FORK}/releases?per_page=100`,
			`https://api.github.com/repos/${FORK}/releases/tags/${encodeURIComponent(TAG)}`,
			`https://github.com/${FORK}/releases/download/${TAG}/${getBinaryName("omp-dogfood")}`,
		]);
		expect(urls.some(url => url.includes(UPSTREAM) || url.includes("registry.npmjs.org"))).toBe(false);
		expect((await fs.readdir(dir)).filter(name => name.endsWith(".bak") || name.endsWith(".new"))).toEqual([]);
	});

	it("only checks when --check is passed", async () => {
		spyOn(console, "log").mockImplementation(() => {});
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp-dogfood");
		await Bun.write(targetPath, "old dogfood binary");
		const urls: string[] = [];

		await runDogfoodUpdateCommand(
			SOURCE,
			{ force: false, check: true },
			{ fetchImpl: makeFetch(getBinaryName("omp-dogfood"), urls), targetPath },
		);

		expect(urls).toEqual([`https://api.github.com/repos/${FORK}/releases?per_page=100`]);
		expect(await Bun.file(targetPath).text()).toBe("old dogfood binary");
	});

	it("refuses to replace a same-named wrapper before downloading", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp-dogfood");
		const wrapper = "#!/bin/sh\necho wrapper\n";
		await Bun.write(targetPath, wrapper);
		await fs.chmod(targetPath, 0o755);
		const urls: string[] = [];

		await expect(
			updateViaBinaryAt(targetPath, VERSION, {
				appName: "omp-dogfood",
				repository: FORK,
				validateExistingTarget: true,
				fetchImpl: makeFetch(getBinaryName("omp-dogfood"), urls),
			}),
		).rejects.toThrow("is a shebang script, not an OMP binary");
		expect(urls).toEqual([]);
		expect(await Bun.file(targetPath).text()).toBe(wrapper);
	});

	it("rejects an asset named for the vanilla executable", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "omp-dogfood");
		await Bun.write(targetPath, "old dogfood binary");
		const urls: string[] = [];

		// The dogfood release publishes `omp-dogfood-*` assets only; asking for
		// the vanilla asset name finds nothing rather than silently installing
		// an upstream-shaped binary.
		await expect(
			updateViaBinaryAt(targetPath, VERSION, {
				appName: "omp-dogfood",
				repository: FORK,
				binaryName: getBinaryName(),
				fetchImpl: makeFetch(getBinaryName("omp-dogfood"), urls),
			}),
		).rejects.toThrow(`has 0 assets named ${getBinaryName()}`);
		expect(await Bun.file(targetPath).text()).toBe("old dogfood binary");
	});
});
