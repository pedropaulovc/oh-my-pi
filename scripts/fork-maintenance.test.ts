import { describe, expect, it } from "bun:test";
import {
	dogfoodTagFor,
	findEquivalentMainBoundary,
	hasActiveDogfoodRun,
	latestDogfoodRelease,
	orderIntegrationTips,
	parsePrivateBranches,
	planDogfoodRelease,
	planPush,
	planRebaseGroups,
} from "./fork-maintenance";

const BASE = "refs/remotes/upstream/main";

describe("parsePrivateBranches", () => {
	it("splits on commas, newlines and spaces, strips refs/heads/, and de-duplicates", () => {
		expect(parsePrivateBranches("feat/a, refs/heads/feat/b\nfeat/c feat/a\n\n")).toEqual([
			"feat/a",
			"feat/b",
			"feat/c",
		]);
	});

	it("drops the branches the script owns so a variable cannot redirect main/dogfood into stack planning", () => {
		expect(parsePrivateBranches("main,dogfood,feat/x")).toEqual(["feat/x"]);
	});

	it("returns nothing when the variable is unset or blank", () => {
		expect(parsePrivateBranches(undefined)).toEqual([]);
		expect(parsePrivateBranches("  \n ,, ")).toEqual([]);
	});
});

describe("findEquivalentMainBoundary", () => {
	it("returns the last patch-equivalent commit before branch-only work starts", () => {
		const first = "a".repeat(40);
		const last = "b".repeat(40);
		const branchCommit = "c".repeat(40);
		expect(findEquivalentMainBoundary(`- ${first}\n- ${last}\n+ ${branchCommit}\n`)).toBe(last);
	});

	it("does not skip an equivalent commit after branch-only work", () => {
		const branchCommit = "a".repeat(40);
		const lateEquivalent = "b".repeat(40);
		expect(findEquivalentMainBoundary(`+ ${branchCommit}\n- ${lateEquivalent}\n`)).toBeUndefined();
	});
});

describe("planRebaseGroups", () => {
	it("rebases only the tip of a stack and carries the intermediate refs base → tip", () => {
		const groups = planRebaseGroups(
			[
				{ name: "mid", head: "bbb", ancestors: ["bottom"] },
				{ name: "bottom", head: "aaa", ancestors: [] },
				{ name: "top", head: "ccc", ancestors: ["bottom", "mid"] },
			],
			BASE,
		);
		expect(groups).toEqual([
			{
				members: ["bottom", "mid", "top"],
				steps: [{ branch: "top", carried: ["bottom", "mid"], onto: BASE, fromOid: undefined }],
			},
		]);
	});

	it("replays only a branch delta when it descended from the old fork main", () => {
		const groups = planRebaseGroups(
			[
				{ name: "bottom", head: "aaa", ancestors: [] },
				{ name: "top", head: "bbb", ancestors: ["bottom"] },
			],
			BASE,
			{ bottom: "old-main", top: "old-main" },
		);
		expect(groups).toEqual([
			{
				members: ["bottom", "top"],
				steps: [{ branch: "top", carried: ["bottom"], onto: BASE, fromOid: "old-main" }],
			},
		]);
	});

	it("keeps branches with no shared history in separate groups so one conflict cannot block the other", () => {
		const groups = planRebaseGroups(
			[
				{ name: "feat/z", head: "zzz", ancestors: [] },
				{ name: "feat/a", head: "aaa", ancestors: [] },
			],
			BASE,
		);
		expect(groups.map(group => group.members)).toEqual([["feat/a"], ["feat/z"]]);
		expect(groups.flatMap(group => group.steps)).toEqual([
			{ branch: "feat/a", carried: [], onto: BASE, fromOid: undefined },
			{ branch: "feat/z", carried: [], onto: BASE, fromOid: undefined },
		]);
	});

	it("replays a second tip off the rewritten shared base instead of duplicating its commits", () => {
		const groups = planRebaseGroups(
			[
				{ name: "shared", head: "s0", ancestors: [] },
				{ name: "tip-b", head: "b0", ancestors: ["shared"] },
				{ name: "tip-a", head: "a0", ancestors: ["shared"] },
			],
			BASE,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.steps).toEqual([
			{ branch: "tip-a", carried: ["shared"], onto: BASE, fromOid: undefined },
			{ branch: "tip-b", carried: [], onto: "shared", fromOid: "s0" },
		]);
	});

	it("ignores ancestry pointing at untracked branches", () => {
		const groups = planRebaseGroups([{ name: "solo", head: "aaa", ancestors: ["gone", "solo"] }], BASE);
		expect(groups).toEqual([
			{ members: ["solo"], steps: [{ branch: "solo", carried: [], onto: BASE, fromOid: undefined }] },
		]);
	});

	it("still plans a member that only direct-parent ancestry data leaves unreachable from a tip", () => {
		// `low` is an ancestor of `mid` but not reported on `high`; it must not vanish.
		const groups = planRebaseGroups(
			[
				{ name: "low", head: "l0", ancestors: [] },
				{ name: "mid", head: "m0", ancestors: ["low"] },
				{ name: "high", head: "h0", ancestors: ["mid"] },
			],
			BASE,
		);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.steps.map(step => step.branch).sort()).toEqual(["high", "low"]);
	});
});

describe("planPush", () => {
	it("leases each rewritten ref against the OID observed before the rebase", () => {
		const plan = planPush([
			{ branch: "feat/b", expected: "old-b", target: "new-b" },
			{ branch: "feat/a", expected: "old-a", target: "new-a" },
		]);
		expect(plan.args).toEqual([
			"push",
			"--atomic",
			"--force-with-lease=refs/heads/feat/a:old-a",
			"--force-with-lease=refs/heads/feat/b:old-b",
			"origin",
			"new-a:refs/heads/feat/a",
			"new-b:refs/heads/feat/b",
		]);
		expect(plan.pushed).toEqual(["feat/a", "feat/b"]);
	});

	it("skips refs the rebase left untouched instead of force-pushing them", () => {
		const plan = planPush([{ branch: "feat/a", expected: "same", target: "same" }]);
		expect(plan.args).toEqual([]);
		expect(plan.pushed).toEqual([]);
		expect(plan.skipped).toEqual(["feat/a"]);
	});

	it("leases an empty OID for a branch that does not exist on the remote yet", () => {
		const plan = planPush([{ branch: "dogfood", expected: null, target: "new" }]);
		// git reads the empty expectation as "the ref must not exist".
		expect(plan.args).toContain("--force-with-lease=refs/heads/dogfood:");
	});
});

describe("dogfoodTagFor", () => {
	it("maps an upstream release tag and revision to its fork dogfood tag", () => {
		expect(dogfoodTagFor("v0.12.4")).toBe("v0.12.4-dogfood.1");
		expect(dogfoodTagFor(" 18.1.19 ", 4)).toBe("v18.1.19-dogfood.4");
	});

	it("refuses prereleases and non-release tags so canaries never trigger a dogfood release", () => {
		expect(dogfoodTagFor("v0.12.4-canary.3")).toBeUndefined();
		expect(dogfoodTagFor("v0.12.4-dogfood.1")).toBeUndefined();
		expect(dogfoodTagFor("nightly")).toBeUndefined();
	});
});

describe("latestDogfoodRelease", () => {
	it("picks the highest revision of the requested version and reports its build source", () => {
		const latest = latestDogfoodRelease(
			[
				{ tag_name: "v18.2.0-dogfood.1", target_commitish: "AAA" },
				{ tag_name: "v18.2.0-dogfood.10", target_commitish: "BBB" },
				{ tag_name: "v18.2.0-dogfood.2", target_commitish: "CCC" },
				{ tag_name: "v18.3.0-dogfood.7", target_commitish: "DDD" },
			],
			"v18.2.0",
		);
		// Revisions are numeric, not lexicographic: .10 outranks .2.
		expect(latest).toEqual({ revision: 10, sourceSha: "bbb" });
	});

	it("ignores other versions and malformed dogfood tags", () => {
		const releases = [
			{ tag_name: "v18.1.22-dogfood.3", target_commitish: "aaa" },
			{ tag_name: "v18.2.0-dogfood.0", target_commitish: "bbb" },
			{ tag_name: "v18.2.0-dogfood", target_commitish: "ccc" },
			{ tag_name: "v18.2.0", target_commitish: "ddd" },
		];
		expect(latestDogfoodRelease(releases, "v18.2.0")).toBeUndefined();
	});
});

describe("planDogfoodRelease", () => {
	it("publishes the first revision when the fork never released this upstream version", () => {
		expect(planDogfoodRelease("v18.2.0", "abc123", [])).toEqual({
			publish: true,
			dogfoodTag: "v18.2.0-dogfood.1",
			revision: 1,
		});
	});

	it("respins the next revision when the dogfood head moved under an already-released version", () => {
		const releases = [{ tag_name: "v18.2.0-dogfood.2", target_commitish: "old000" }];
		expect(planDogfoodRelease("v18.2.0", "new111", releases)).toEqual({
			publish: true,
			dogfoodTag: "v18.2.0-dogfood.3",
			revision: 3,
		});
	});

	it("publishes nothing when the newest release already built this exact head", () => {
		const releases = [{ tag_name: "v18.2.0-dogfood.2", target_commitish: "ABC123" }];
		const plan = planDogfoodRelease("v18.2.0", "abc123", releases);
		expect(plan.publish).toBe(false);
		expect(plan.dogfoodTag).toBe("v18.2.0-dogfood.2");
	});

	it("refuses to publish for an upstream prerelease", () => {
		const plan = planDogfoodRelease("v18.2.0-canary.4", "abc123", []);
		expect(plan.publish).toBe(false);
		expect(plan.dogfoodTag).toBeUndefined();
	});
});

describe("hasActiveDogfoodRun", () => {
	it("treats a queued or running build of the same upstream tag as in flight", () => {
		const runs = [{ display_title: "Dogfood v0.12.4", status: "in_progress" }];
		expect(hasActiveDogfoodRun(runs, "v0.12.4")).toBe(true);
		expect(hasActiveDogfoodRun([{ display_title: "Dogfood v0.12.4", status: "queued" }], "v0.12.4")).toBe(true);
	});

	it("does not suppress a dispatch for a finished run or a different tag", () => {
		const runs = [
			{ display_title: "Dogfood v0.12.4", status: "completed" },
			{ display_title: "Dogfood v0.12.3", status: "in_progress" },
		];
		expect(hasActiveDogfoodRun(runs, "v0.12.4")).toBe(false);
	});
});

describe("orderIntegrationTips", () => {
	it("integrates PR heads oldest-first, then private branches by name", () => {
		const ordered = orderIntegrationTips([
			{ branch: "private/z" },
			{ branch: "feat/new", prNumber: 91 },
			{ branch: "private/a" },
			{ branch: "feat/old", prNumber: 12 },
		]);
		expect(ordered.map(tip => tip.branch)).toEqual(["feat/old", "feat/new", "private/a", "private/z"]);
	});
});
