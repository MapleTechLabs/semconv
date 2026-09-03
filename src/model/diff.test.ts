import { describe, expect, test } from "bun:test"
import { readSemconv } from "../ingest/store.ts"
import { diffSemconv } from "./diff.ts"

/**
 * These run against the committed snapshots rather than hand-written fixtures.
 * The point of the diff engine is to agree with what OpenTelemetry actually
 * shipped, so the assertions below are lifted straight from upstream release
 * notes -- if a normalizer change starts inventing or losing changes, this is
 * where it shows up.
 */

const v143 = await readSemconv("1.43.0")
const v144 = await readSemconv("1.44.0")
const v144diff = diffSemconv(v143, v144)

const find = (id: string, kind: string) => v144diff.changes.find((c) => c.id === id && c.kind === kind)

describe("v1.43.0 -> v1.44.0", () => {
	test("catches the k8s paging-fault metric renames", () => {
		// Upstream: "Rename k8s.node.memory.paging.faults, k8s.pod.memory.paging.faults
		// and container.memory.paging.faults metrics by dropping the memory segment."
		for (const [from, to] of [
			["container.memory.paging.faults", "container.paging.faults"],
			["k8s.node.memory.paging.faults", "k8s.node.paging.faults"],
			["k8s.pod.memory.paging.faults", "k8s.pod.paging.faults"],
		]) {
			const change = find(from as string, "renamed")
			expect(change, `expected a rename for ${from}`).toBeDefined()
			expect(change?.renamedTo).toBe(to as string)
			expect(change?.entity).toBe("metric")
		}
	})

	test("catches the memory.usage instrument changes as breaking", () => {
		for (const name of ["container.memory.usage", "k8s.node.memory.usage", "k8s.pod.memory.usage"]) {
			const change = find(name, "instrument-changed")
			expect(change, `expected an instrument change for ${name}`).toBeDefined()
			expect(change?.to).toBe("updowncounter")
			expect(change?.severity).toBe("breaking")
		}
	})

	test("catches the k8s memory promotions to release_candidate", () => {
		const promoted = v144diff.changes.filter((c) => c.kind === "stability-changed" && c.to === "release_candidate")
		expect(promoted.map((c) => c.id)).toContain("k8s.pod.memory.working_set")
		expect(promoted.map((c) => c.id)).toContain("network.interface.name")
	})

	/**
	 * The regression that motivated dual-format support. v1.44.0 moved
	 * `server.*`, `client.*`, `source.*`, `destination.*` and all of `hw.*` to the
	 * definition/2 file format; a format-1-only reader reports every one of them
	 * as deleted from the registry. A tracker that cries "server.address was
	 * removed" is worse than no tracker.
	 */
	test("does not report format-migrated definitions as removed", () => {
		const removed = v144diff.changes.filter((c) => c.kind === "removed").map((c) => c.id)
		for (const id of ["server.address", "server.port", "client.address", "destination.address", "hw.errors"]) {
			expect(removed, `${id} must not be reported as removed`).not.toContain(id)
		}
	})

	test("reports no removal of a stable attribute", () => {
		const stableRemovals = v144diff.changes.filter(
			(c) => c.kind === "removed" && c.entity === "attribute" && c.stability === "stable",
		)
		expect(stableRemovals).toEqual([])
	})

	test("keeps the breaking set small enough to read", () => {
		// If this ever balloons, the severity rules have drifted, not the spec.
		expect(v144diff.counts.breaking).toBeLessThan(10)
	})
})

describe("attribute lifecycle across releases", () => {
	test("deployment.environment is a rename to deployment.environment.name", async () => {
		const attribute = v144.attributes.find((a) => a.id === "deployment.environment")
		expect(attribute?.deprecated?.reason).toBe("renamed")
		expect(attribute?.deprecated?.renamedTo).toBe("deployment.environment.name")
	})

	test("db.statement is a rename to db.query.text", () => {
		const attribute = v144.attributes.find((a) => a.id === "db.statement")
		expect(attribute?.deprecated?.reason).toBe("renamed")
		expect(attribute?.deprecated?.renamedTo).toBe("db.query.text")
	})

	test("stable attributes carry their usage edges", () => {
		const queryText = v144.attributes.find((a) => a.id === "db.query.text")
		expect(queryText?.stability).toBe("stable")
		expect(queryText?.usedBy.length).toBeGreaterThan(0)
		expect(queryText?.usedBy.some((u) => u.groupType === "metric")).toBe(true)
	})
})

describe("diff invariants", () => {
	test("a snapshot against itself produces no changes", () => {
		expect(diffSemconv(v144, v144).changes).toEqual([])
	})

	test("every consecutive pair diffs without inventing stable removals", async () => {
		const versions = ["1.40.0", "1.41.0", "1.41.1", "1.42.0", "1.43.0", "1.44.0"]
		for (let i = 1; i < versions.length; i++) {
			const before = await readSemconv(versions[i - 1] as string)
			const after = await readSemconv(versions[i] as string)
			const diff = diffSemconv(before, after)
			const stableRemovals = diff.changes.filter((c) => c.kind === "removed" && c.stability === "stable")
			expect(stableRemovals.map((c) => c.id), `${diff.from} -> ${diff.to}`).toEqual([])
		}
	})
})
