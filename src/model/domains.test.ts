import { describe, expect, test } from "bun:test"
import { catalog } from "./catalog.ts"
import { buildDomains, DOMAINS, domainForNamespace, registryAttributes, ruleDocs, ruleUrl } from "./domains.ts"

const data = await catalog()

describe("domain taxonomy", () => {
	test("every namespace in either registry is placed in exactly one domain", () => {
		const namespaces = new Set(registryAttributes(data).map(({ attribute }) => attribute.namespace))
		const unplaced = [...namespaces].filter((name) => !domainForNamespace(name))
		// A release that adds a namespace has to be classified here, or the
		// registry page silently files it under "Unclassified".
		expect(unplaced).toEqual([])
	})

	test("no namespace is claimed by two domains", () => {
		const seen = new Map<string, string>()
		for (const domain of DOMAINS) {
			for (const name of [...domain.namespaces, ...(domain.aliases ?? [])]) {
				expect(seen.get(name)).toBeUndefined()
				seen.set(name, domain.slug)
			}
		}
	})

	test("slugs are unique and url-safe", () => {
		const slugs = DOMAINS.map((d) => d.slug)
		expect(new Set(slugs).size).toBe(slugs.length)
		for (const slug of slugs) expect(slug).toMatch(/^[a-z0-9-]+$/)
	})
})

describe("assembled domains", () => {
	const domains = buildDomains(data)

	test("partition the registry: every attribute lands in one domain", () => {
		const total = domains.reduce((n, domain) => n + domain.attributes.length, 0)
		expect(total).toBe(registryAttributes(data).length)
	})

	test("each domain carries attributes and at least one signal or metric, or is a signal itself", () => {
		for (const domain of domains) {
			expect(domain.attributes.length).toBeGreaterThan(0)
			const emitted = domain.metrics.length + domain.spans.length + domain.events.length + domain.entities.length
			expect(emitted + (domain.wire?.messages.length ?? 0)).toBeGreaterThan(0)
		}
	})

	test("databases pull together the registry and the spec areas that bind it", () => {
		const db = domains.find((d) => d.slug === "database")
		if (!db) throw new Error("no database domain")
		expect(db.attributes.some(({ attribute }) => attribute.id === "db.query.text")).toBe(true)
		expect(db.metrics.some((m) => m.name.startsWith("db."))).toBe(true)
		expect(db.spans.length).toBeGreaterThan(0)
		// Spans are bound by the trace specification even though its prose never
		// says "database" — that link is the point of the page.
		expect(db.governance.some((g) => g.area === "trace")).toBe(true)
	})

	test("MCP is its own domain: its spans and metrics leave Generative AI", () => {
		const mcp = domains.find((d) => d.slug === "mcp")
		const genai = domains.find((d) => d.slug === "gen-ai")
		if (!mcp || !genai) throw new Error("missing mcp or gen-ai domain")
		expect(mcp.attributes.some(({ attribute }) => attribute.id === "mcp.method.name")).toBe(true)
		expect(mcp.metrics.map((m) => m.name)).toContain("mcp.server.operation.duration")
		// Moved signals stay behind in semantic-conventions as stubs; each shows once.
		expect(mcp.spans.map((s) => s.spanKind).sort()).toEqual(["client", "server"])
		expect(new Set(mcp.metrics.map((m) => m.name)).size).toBe(mcp.metrics.length)
		expect(genai.metrics.some((m) => m.name.startsWith("mcp."))).toBe(false)
		expect(genai.attributes.some(({ attribute }) => attribute.namespace === "mcp")).toBe(false)
	})

	test("profiling is its own domain: profile and pprof leave Runtimes, and nothing else does", () => {
		const profiling = domains.find((d) => d.slug === "profiling")
		const runtime = domains.find((d) => d.slug === "runtime")
		if (!profiling || !runtime) throw new Error("missing profiling or runtime domain")
		expect(profiling.namespaces.map((ns) => ns.name).sort()).toEqual(["pprof", "profile"])
		expect(profiling.attributes.some(({ attribute }) => attribute.id === "profile.frame.type")).toBe(true)

		const runtimeNamespaces = new Set(runtime.namespaces.map((ns) => ns.name))
		expect(runtimeNamespaces.has("profile") || runtimeNamespaces.has("pprof")).toBe(false)
		// The build ids a Mapping must carry stay with the process they describe.
		expect(runtime.attributes.some(({ attribute }) => attribute.id === "process.executable.build_id.gnu")).toBe(true)
		for (const name of ["process", "thread", "code", "jvm", "go", "nodejs", "v8js", "cpython", "dotnet", "aspnetcore"]) {
			expect(runtimeNamespaces.has(name)).toBe(true)
		}
	})

	test("a signal domain is bound by its own specification area, named or not", () => {
		const profiling = domains.find((d) => d.slug === "profiling")
		if (!profiling) throw new Error("no profiling domain")
		expect(profiling.governance.map((g) => g.area)).toEqual(["profiles"])
		// The Mapping build id rule never says "profile"; it binds profiles all the same.
		expect(profiling.requirements.some(({ section }) => section.path === "specification/profiles/mappings.md")).toBe(true)
		for (const { section } of profiling.requirements) expect(section.path.startsWith("docs/")).toBe(false)
	})

	test("a signal domain's wire data comes from the tracked proto releases", () => {
		const wire = domains.find((d) => d.slug === "profiling")?.wire
		if (!wire) throw new Error("profiling has no wire data")
		const names = new Set(wire.messages.map((m) => m.name))
		// The hand-written endpoint has to name a service the proto actually defines.
		expect(names.has(wire.def.grpcService)).toBe(true)
		for (const pkg of wire.def.packages) expect(wire.messages.some((m) => m.name.startsWith(`${pkg}.`))).toBe(true)
		for (const message of wire.messages) expect(wire.def.packages.some((pkg) => message.name.startsWith(`${pkg}.`))).toBe(true)

		expect(wire.history.map((r) => r.version)).toEqual(data.proto.diffs.map((d) => d.to))
		for (const release of wire.history) {
			for (const change of [...release.incompatible, ...release.compatible]) {
				expect(wire.def.packages.some((pkg) => change.id.startsWith(`${pkg}.`))).toBe(true)
			}
			for (const change of release.compatible) expect(change.severity).toBe("informational")
		}
		const firstIncompatible = wire.history.find((r) => r.incompatible.length > 0)
		expect(wire.lastIncompatible?.version).toBe(firstIncompatible?.version)
	})

	test("rules link to the document each one paraphrases", () => {
		for (const domain of domains) {
			const rules = domain.def.rules
			if (!rules) continue
			const docs = ruleDocs(rules)
			expect(docs[0]).toBe(rules.doc)
			for (const rule of rules.items) {
				const url = ruleUrl(rules, rule)
				expect(docs.some((doc) => url === `${doc}#${rule.anchor}`)).toBe(true)
				// A `.proto` file has no headings, so its rules cite line ranges.
				expect(/^L\d+(-L\d+)?$/.test(rule.anchor)).toBe(url.includes(".proto#"))
			}
		}
	})
})
