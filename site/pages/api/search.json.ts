import type { APIRoute } from "astro"
import { catalog, SOURCE_REPO } from "../../../src/model/catalog.ts"
import { buildDomains, domainForNamespace, prefixOf, registryAttributes } from "../../../src/model/domains.ts"
import { json } from "../../lib/api.ts"

/**
 * One index behind the search box, covering everything the site knows: both
 * attribute registries, metrics, signals, RFC 2119 requirements, OTLP messages
 * and the domain pages.
 *
 * Static and fetched once by the client, because the alternative — searching
 * only attribute ids, which is what the registry filter did — cannot answer
 * "what does the spec say about retries" at all. Prose is truncated: this file
 * is for finding a thing, and the page it links to has the full text.
 */

const clean = (text: string) =>
	text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/`/g, "")
		.replace(/\s+/g, " ")
		.trim()

const truncate = (text: string, n: number) => (text.length <= n ? text : `${text.slice(0, n - 1)}…`)

/** Metrics and signals have no page of their own; their domain page is where they are shown. */
const domainHref = (name: string) => {
	const domain = domainForNamespace(prefixOf(name))
	return domain ? `/domains/${domain.slug}` : "/domains"
}

export interface SearchEntry {
	/** `attribute`, `metric`, `span`, `event`, `entity`, `requirement`, `otlp`, `domain`. */
	readonly type: string
	readonly id: string
	readonly text: string
	readonly url: string
	/** Stability, namespace, level — whatever distinguishes one hit from its neighbours. */
	readonly meta: string
}

export const GET: APIRoute = async () => {
	const data = await catalog()
	const entries: SearchEntry[] = []

	for (const domain of buildDomains(data)) {
		entries.push({
			type: "domain",
			id: domain.title,
			text: clean(domain.blurb),
			url: `/domains/${domain.slug}`,
			meta: domain.namespaces.map((ns) => ns.name).join(" "),
		})
	}

	for (const { attribute, registry } of registryAttributes(data)) {
		entries.push({
			type: "attribute",
			id: attribute.id,
			text: truncate(clean(attribute.brief), 160),
			url: `/attributes/${encodeURIComponent(attribute.id)}`,
			meta: [
				attribute.deprecated ? "deprecated" : attribute.stability,
				attribute.type,
				registry === "genai" ? "genai" : attribute.namespace,
			].join(" · "),
		})
	}

	for (const metric of [...data.metrics, ...data.genai.latest.metrics]) {
		entries.push({
			type: "metric",
			id: metric.name,
			text: truncate(clean(metric.brief), 160),
			url: `${domainHref(metric.name)}#metrics`,
			meta: [metric.deprecated ? "deprecated" : metric.stability, metric.instrument, metric.unit || "1"].join(" · "),
		})
	}

	for (const signal of [...data.signals, ...data.genai.latest.signals]) {
		entries.push({
			type: signal.kind,
			id: signal.name,
			text: truncate(clean(signal.brief), 160),
			url: `${domainHref(signal.id.replace(/^(span|event|entity)\./, ""))}#signals`,
			meta: [signal.deprecated ? "deprecated" : signal.stability, signal.spanKind ?? ""].filter(Boolean).join(" · "),
		})
	}

	const requirementSources = [
		{ sections: data.spec.latest.sections, repo: SOURCE_REPO.spec, tag: `v${data.spec.latest.version}` },
		{ sections: data.proto.latest.sections, repo: SOURCE_REPO.proto, tag: `v${data.proto.latest.version}` },
	]
	for (const { sections, repo, tag } of requirementSources) {
		for (const section of sections) {
			for (const statement of section.normative) {
				entries.push({
					type: "requirement",
					// The section is what a reader recognises; the level is the qualifier.
					id: section.title,
					text: truncate(clean(statement.text), 240),
					url: `${repo}/blob/${tag}/${section.path}#${section.anchor}`,
					meta: `${statement.level} · ${section.status}`,
				})
			}
		}
	}

	for (const message of data.proto.latest.messages) {
		entries.push({
			type: "otlp",
			id: message.name,
			text: truncate(clean(message.comment ?? ""), 160),
			url: "/otlp",
			meta: [message.kind, message.file.replace("opentelemetry/proto/", "").replace(/\.proto$/, "")].join(" · "),
		})
	}

	return json({
		semconvVersion: data.semconv.latest.version,
		specVersion: data.spec.latest.version,
		protoVersion: data.proto.latest.version,
		count: entries.length,
		entries,
	})
}

