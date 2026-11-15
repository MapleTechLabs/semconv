import { describe, expect, test } from "bun:test"
import { normativeStatements } from "./spec.ts"

const texts = (body: string) => normativeStatements(body, "doc.md#section").map((statement) => statement.text)

describe("requirement text", () => {
	test("identifiers keep their underscores, in and out of code spans", () => {
		const [first, second] = texts(
			"Use `process.executable.build_id.gnu` when present. It is RECOMMENDED for `process.executable.build_id.htlhash` to be set.\n\n" +
				"The trace_id MUST match the span_id of the parent.",
		)
		expect(first).toBe("It is RECOMMENDED for `process.executable.build_id.htlhash` to be set.")
		expect(second).toBe("The trace_id MUST match the span_id of the parent.")
	})

	test("emphasis markers around a phrase come off", () => {
		expect(texts("**Status**: the SDK _MUST NOT_ block, and __SHOULD__ *log* instead.")).toEqual([
			"Status: the SDK MUST NOT block, and SHOULD log instead.",
		])
	})

	test("a glob or a pointer is not emphasis", () => {
		expect(texts("Names matching http.* MUST be reserved, as is *.proto.")).toEqual([
			"Names matching http.* MUST be reserved, as is *.proto.",
		])
	})
})

describe("lists under a lead-in", () => {
	test("a requirement that ends in a colon carries the items it introduces", () => {
		expect(
			texts("A `Mapping` MUST have at least one of the following attributes:\n\n- `build_id.gnu`\n- `build_id.go`.\n\nUnrelated prose."),
		).toEqual(["A `Mapping` MUST have at least one of the following attributes: `build_id.gnu`; `build_id.go`"])
	})

	test("an item that states its own requirement stays a statement, with what is nested under it", () => {
		expect(
			texts(
				"The API MUST provide the following:\n\n- Get a value\n- Set a value, which SHOULD accept:\n  - a name\n  - a value\n- Remove a value",
			),
		).toEqual([
			"The API MUST provide the following: Get a value; Remove a value",
			"Set a value, which SHOULD accept: a name; a value",
		])
	})

	test("a nested lead-in takes only the items indented under it", () => {
		expect(texts("- REQUIRED parameters:\n  - the name\n- An unrelated sibling")).toEqual(["REQUIRED parameters: the name"])
	})

	test("a colon with no list after it is left alone", () => {
		expect(texts("The value MUST be one of:\n\nSee the table below.")).toEqual(["The value MUST be one of:"])
	})
})
