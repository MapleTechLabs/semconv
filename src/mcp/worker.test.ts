import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import worker from "./worker.ts"

/**
 * The Worker's only dependency is the `ASSETS` binding, so serving `dist/`
 * off disk exercises the real code path end to end without wrangler. It does
 * mean these tests need a build first, which is why they skip rather than fail
 * when `dist/` is absent.
 */
const env = {
	ASSETS: {
		fetch: async (request: Request) => {
			const path = new URL(request.url).pathname
			try {
				return new Response(await readFile(`${process.cwd()}/dist${decodeURIComponent(path)}`))
			} catch {
				return new Response("not found", { status: 404 })
			}
		},
	},
}

const built = await Bun.file(`${process.cwd()}/dist/api/attributes.json`).exists()

const call = async (name: string, args: Record<string, unknown> = {}) => {
	const response = await worker.fetch(
		new Request("https://semconv.com/mcp", {
			method: "POST",
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		}),
		env,
	)
	const body = (await response.json()) as { result: { content: { text: string }[] } }
	return JSON.parse(body.result.content[0]?.text ?? "{}")
}

describe.skipIf(!built)("mcp worker", () => {
	test("initialize advertises tools", async () => {
		const response = await worker.fetch(
			new Request("https://semconv.com/mcp", {
				method: "POST",
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
			}),
			env,
		)
		const body = (await response.json()) as { result: { capabilities: Record<string, unknown> } }
		expect(body.result.capabilities).toHaveProperty("tools")
	})

	test("tools/list names every tool", async () => {
		const response = await worker.fetch(
			new Request("https://semconv.com/mcp", {
				method: "POST",
				body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
			}),
			env,
		)
		const body = (await response.json()) as { result: { tools: { name: string }[] } }
		expect(body.result.tools.map((t) => t.name).sort()).toEqual([
			"check_attribute_names",
			"diff_versions",
			"get_attribute",
			"get_otlp_message",
			"list_versions",
			"search_attributes",
			"search_requirements",
		])
	})

	/**
	 * The keys below are the ones Maple's own warehouse reads, which is where
	 * this tool came from: an attribute audit that a model would otherwise answer
	 * from stale training data.
	 */
	test("check_attribute_names classifies renamed, current and unknown keys", async () => {
		const result = await call("check_attribute_names", {
			names: [
				"deployment.environment",
				"deployment.environment.name",
				"db.statement",
				"db.query.text",
				"maple.org_id",
			],
		})
		const byName = Object.fromEntries(result.results.map((r: { name: string }) => [r.name, r]))

		expect(byName["deployment.environment"].status).toBe("renamed")
		expect(byName["deployment.environment"].replacement).toBe("deployment.environment.name")
		expect(byName["db.statement"].replacement).toBe("db.query.text")
		expect(byName["db.query.text"].status).toBe("ok")
		expect(byName["db.query.text"].stability).toBe("stable")
		// A vendor-namespaced key is not in the registry and must not be reported
		// as an error - "unknown" is the honest answer.
		expect(byName["maple.org_id"].status).toBe("unknown")
		// A vendor key is absent by design, so it counts as not-in-registry rather
		// than as something to fix.
		expect(result.needsAttention).toBe(2)
		expect(result.notInRegistry).toBe(1)
	})

	/**
	 * The case the GenAI registry exists to create: v1.44.0 deprecated the whole
	 * `gen_ai.*` namespace in semantic-conventions with a "Moved to..." note, and
	 * the live definitions are now in their own repository. Reading only the
	 * first registry reports ~40 attributes in active production use as dead.
	 */
	test("check_attribute_names follows an attribute across registries", async () => {
		const result = await call("check_attribute_names", {
			names: ["gen_ai.request.model", "gen_ai.usage.input_tokens", "db.statement"],
		})
		const byName = Object.fromEntries(result.results.map((r: { name: string }) => [r.name, r]))

		expect(byName["gen_ai.request.model"].status).toBe("moved")
		expect(byName["gen_ai.request.model"].registry).toBe("genai")
		expect(byName["gen_ai.usage.input_tokens"].status).toBe("moved")
		// A move needs no code change, so it must not inflate the count that does.
		expect(result.needsAttention).toBe(1)
	})

	test("check_attribute_names resolves template attributes by prefix", async () => {
		const result = await call("check_attribute_names", { names: ["http.request.header.content-type"] })
		expect(result.results[0].status).toBe("ok")
	})

	test("get_attribute returns definition plus history", async () => {
		const result = await call("get_attribute", { id: "db.statement" })
		expect(result.attribute.deprecated.renamedTo).toBe("db.query.text")
		expect(result.history.some((e: { kind: string }) => e.kind === "renamed")).toBe(true)
	})

	test("search_attributes narrows by namespace and deprecation", async () => {
		const result = await call("search_attributes", { namespace: "db", deprecated_only: true, limit: 500 })
		expect(result.matched).toBeGreaterThan(0)
		expect(result.attributes.every((a: { namespace: string }) => a.namespace === "db")).toBe(true)
		expect(result.attributes.map((a: { id: string }) => a.id)).toContain("db.statement")
	})

	test("diff_versions drops editorial noise unless asked", async () => {
		const lean = await call("diff_versions", { from: "1.43.0", to: "1.44.0" })
		const full = await call("diff_versions", { from: "v1.43.0", to: "v1.44.0", include_editorial: true })
		expect(lean.changes.length).toBeLessThan(full.changes.length)
		expect(lean.changes.every((c: { severity: string }) => c.severity !== "informational")).toBe(true)
	})

	test("diff_versions reaches the specification and OTLP too", async () => {
		const spec = await call("diff_versions", { source: "spec", from: "1.59.0", to: "1.60.0" })
		expect(spec.source).toBe("spec")
		expect(spec.changes.some((c: { entity: string }) => c.entity === "requirement")).toBe(true)

		const proto = await call("diff_versions", { source: "proto", from: "1.10.0", to: "1.11.0" })
		expect(proto.source).toBe("proto")
	})

	/**
	 * The OTLP protocol specification is not in the specification repository -
	 * it ships in `docs/specification.md` of opentelemetry-proto. If this stops
	 * finding partial-success rules, that source has silently dropped out.
	 */
	test("search_requirements covers the OTLP protocol document", async () => {
		const result = await call("search_requirements", { query: "partial_success", level: "MUST" })
		expect(result.matched).toBeGreaterThan(0)
		expect(result.requirements.every((r: { level: string }) => r.level === "MUST")).toBe(true)
		expect(result.requirements.some((r: { source: string }) => r.source === "proto")).toBe(true)
	})

	test("search_requirements narrows by section path", async () => {
		const result = await call("search_requirements", { section: "trace/sdk", limit: 500 })
		expect(result.matched).toBeGreaterThan(0)
		expect(result.requirements.every((r: { section: string }) => r.section.includes("trace/sdk"))).toBe(true)
	})

	test("get_otlp_message resolves a bare name and keeps field numbers", async () => {
		const result = await call("get_otlp_message", { name: "Span" })
		expect(result.message.name).toBe("opentelemetry.proto.trace.v1.Span")
		const traceId = result.message.fields.find((f: { name: string }) => f.name === "trace_id")
		expect(traceId.number).toBe(1)
		expect(traceId.type).toBe("bytes")
	})

	test("get_otlp_message suggests alternatives instead of failing blankly", async () => {
		const result = await call("get_otlp_message", { name: "DataPoint" })
		expect(result.error).toBeDefined()
		expect(result.didYouMean.length).toBeGreaterThan(0)
	})

	test("a backwards version pair explains itself instead of 500ing", async () => {
		const result = await call("diff_versions", { from: "1.44.0", to: "1.40.0" })
		expect(result.error).toContain("list_versions")
	})

	test("non-mcp paths fall through to the static site", async () => {
		const response = await worker.fetch(new Request("https://semconv.com/api/versions.json"), env)
		expect(response.status).toBe(200)
	})

	/**
	 * True of the Worker, and in production true only for paths with no matching
	 * asset — Cloudflare's asset layer answers the rest before the Worker runs.
	 * See the comment on the fetch handler.
	 */
	test("www redirects to the apex, preserving the path", async () => {
		const response = await worker.fetch(new Request("https://www.semconv.com/attributes/db.query.text"), env)
		expect(response.status).toBe(301)
		expect(response.headers.get("location")).toBe("https://semconv.com/attributes/db.query.text")
	})
})
