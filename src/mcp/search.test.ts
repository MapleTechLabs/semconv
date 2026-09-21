import { describe, expect, test } from "bun:test"
import { retrieve, tokens, type IndexEntry } from "./search.ts"

const entries: IndexEntry[] = [
	{ type: "attribute", id: "http.response.status_code", text: "HTTP response status code.", url: "/attributes/http.response.status_code", meta: "stable · int · http" },
	{ type: "attribute", id: "http.status_code", text: "Deprecated, use http.response.status_code instead.", url: "/attributes/http.status_code", meta: "deprecated · int · http", renamedTo: "http.response.status_code" },
	{ type: "attribute", id: "db.query.text", text: "The database query being executed.", url: "/attributes/db.query.text", meta: "stable · string · db" },
	{ type: "metric", id: "http.server.request.duration", text: "Duration of HTTP server requests.", url: "/domains/http#metrics", meta: "stable · histogram · s" },
	{ type: "requirement", id: "Retry", text: "Transient errors MUST be handled with a retry strategy.", url: "https://example.test/spec", meta: "MUST · Stable" },
	{ type: "domain", id: "HTTP and the web", text: "Client and server HTTP calls.", url: "/domains/http", meta: "http url browser" },
]

describe("tokens", () => {
	test("drop filler and keep identifiers whole", () => {
		expect(tokens("Which attribute holds the HTTP status code?")).toEqual(["holds", "http", "status", "code"])
		expect(tokens("is db.statement still a thing")).toEqual(["db.statement", "thing"])
	})
})

describe("retrieve", () => {
	test("a prose question ranks the current attribute over the deprecated one", () => {
		const hits = retrieve(entries, "Which attribute holds the HTTP status code?")
		expect(hits[0]?.id).toBe("http.response.status_code")
		expect(hits.map((h) => h.id)).toContain("http.status_code")
	})

	test("asking about a rename keeps the deprecated row competitive", () => {
		expect(retrieve(entries, "is http.status_code deprecated?")[0]?.id).toBe("http.status_code")
	})

	test("type narrows, signal covers spans events and entities", () => {
		expect(retrieve(entries, "http", { type: "metric" }).map((h) => h.id)).toEqual(["http.server.request.duration"])
		expect(retrieve(entries, "http", { type: "signal" })).toEqual([])
	})

	test("nothing matches nothing", () => {
		expect(retrieve(entries, "the and of")).toEqual([])
		expect(retrieve(entries, "kubernetes pods")).toEqual([])
	})
})
