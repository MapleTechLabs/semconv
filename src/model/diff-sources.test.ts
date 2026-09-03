import { describe, expect, test } from "bun:test"
import { listSnapshots, readSnapshot } from "../ingest/store.ts"
import { diffProto } from "./diff-proto.ts"
import { diffSpec } from "./diff-spec.ts"
import type { ProtoSnapshot, SpecSnapshot } from "./types.ts"

/**
 * Asserted against real releases rather than fixtures. Both differs exist to
 * suppress noise as much as to report change, so most of what is checked here
 * is what must *not* appear.
 */

const specVersions = (await listSnapshots("spec")).reverse()
const protoVersions = (await listSnapshots("proto")).reverse()

const spec = (version: string) => readSnapshot<SpecSnapshot>("spec", version)
const proto = (version: string) => readSnapshot<ProtoSnapshot>("proto", version)

describe("specification prose", () => {
	const latest = specVersions.at(-1) as string
	const previous = specVersions.at(-2) as string

	test("extracts requirements at every level", async () => {
		const snapshot = await spec(latest)
		const levels = new Set(snapshot.sections.flatMap((s) => s.normative).map((n) => n.level))
		expect(levels).toContain("MUST")
		expect(levels).toContain("MUST NOT")
		expect(levels).toContain("SHOULD")
		expect(levels).toContain("MAY")
	})

	test("a snapshot against itself produces no changes", async () => {
		const snapshot = await spec(latest)
		expect(diffSpec(snapshot, snapshot).changes).toEqual([])
	})

	/**
	 * v1.60.0 split `resource/sdk.md#merge` in two and carried its MUSTs across
	 * verbatim. Matching requirements only within a section reported each of
	 * those twice - once as a stable requirement being dropped, once as a new one
	 * appearing - which is the loudest possible way to say nothing happened.
	 */
	test("relocated requirements read as moved, not as dropped and re-added", async () => {
		const diff = diffSpec(await spec("1.59.0"), await spec("1.60.0"))
		const moved = diff.changes.filter((c) => c.kind === "requirement-moved")
		expect(moved.length).toBeGreaterThan(0)

		const dropped = diff.changes.filter((c) => c.kind === "requirement-removed")
		for (const change of dropped) {
			expect(change.detail).not.toContain("The resulting resource MUST have all attributes")
		}
	})

	test("reports each release as a readable number of consequential changes", async () => {
		for (let i = 1; i < specVersions.length; i++) {
			const diff = diffSpec(await spec(specVersions[i - 1] as string), await spec(specVersions[i] as string))
			const significant = diff.changes.filter((c) => c.severity !== "informational")
			// A release that looks like a hundred breaking prose changes means the
			// sentence splitter drifted, not that the spec was rewritten.
			expect(significant.length, `${diff.from} -> ${diff.to}`).toBeLessThan(80)
		}
	})

	test("requirement changes point at a readable section", async () => {
		const diff = diffSpec(await spec(previous), await spec(latest))
		for (const change of diff.changes.filter((c) => c.entity === "requirement")) {
			expect(change.href, change.id).toBeDefined()
			expect(change.id).toContain("#")
		}
	})
})

describe("OTLP definitions", () => {
	const latest = protoVersions.at(-1) as string

	test("parses field numbers, types and oneof membership", async () => {
		const snapshot = await proto(latest)
		const span = snapshot.messages.find((m) => m.name === "opentelemetry.proto.trace.v1.Span")
		expect(span).toBeDefined()
		const traceId = span?.fields.find((f) => f.name === "trace_id")
		expect(traceId).toEqual(expect.objectContaining({ number: 1, type: "bytes" }))

		// AnyValue is a union; losing the oneof would make its fields look
		// independently settable, which is exactly wrong.
		const anyValue = snapshot.messages.find((m) => m.name === "opentelemetry.proto.common.v1.AnyValue")
		expect(anyValue?.fields.every((f) => f.oneof === "value")).toBe(true)
	})

	test("parses enums and retired field numbers", async () => {
		const snapshot = await proto(latest)
		const spanKind = snapshot.messages.find((m) => m.name.endsWith("Span.SpanKind"))
		expect(spanKind?.kind).toBe("enum")
		expect(spanKind?.values.find((v) => v.name === "SPAN_KIND_SERVER")?.number).toBe(2)

		const status = snapshot.messages.find((m) => m.name === "opentelemetry.proto.trace.v1.Status")
		expect(status?.reserved).toContain(1)
	})

	test("carries the OTLP protocol prose, which the spec repository does not", async () => {
		const snapshot = await proto(latest)
		const statements = snapshot.sections.flatMap((s) => s.normative)
		expect(statements.length).toBeGreaterThan(50)
		expect(statements.some((n) => n.text.includes("partial_success"))).toBe(true)
	})

	test("a snapshot against itself produces no changes", async () => {
		const snapshot = await proto(latest)
		expect(diffProto(snapshot, snapshot).changes).toEqual([])
	})

	/**
	 * The claim the OTLP page makes. Every removal and renumbering in the tracked
	 * history happened inside a `v1development` package; if a released one ever
	 * breaks, this is where it surfaces.
	 */
	test("no breaking change to a released wire definition, ever", async () => {
		for (let i = 1; i < protoVersions.length; i++) {
			const diff = diffProto(await proto(protoVersions[i - 1] as string), await proto(protoVersions[i] as string))
			const breaking = diff.changes.filter((c) => c.severity === "breaking")
			expect(breaking.map((c) => c.id), `${diff.from} -> ${diff.to}`).toEqual([])
		}
	})

	test("development-package churn is reported, just not as breaking", async () => {
		const diff = diffProto(await proto("1.8.0"), await proto("1.9.0"))
		const notable = diff.changes.filter((c) => c.severity === "notable")
		expect(notable.length).toBeGreaterThan(0)
		expect(notable.every((c) => c.id.includes("development"))).toBe(true)
	})
})
