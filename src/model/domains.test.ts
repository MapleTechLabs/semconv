import { describe, expect, test } from "bun:test"
import { catalog } from "./catalog.ts"
import { buildDomains, DOMAINS, domainForNamespace, registryAttributes } from "./domains.ts"

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

	test("each domain carries attributes and at least one signal or metric", () => {
		for (const domain of domains) {
			expect(domain.attributes.length).toBeGreaterThan(0)
			expect(domain.metrics.length + domain.spans.length + domain.events.length + domain.entities.length).toBeGreaterThan(0)
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
})
