import type { APIRoute } from "astro"
import { catalog } from "../../../src/model/catalog.ts"
import { buildDomains } from "../../../src/model/domains.ts"
import { json } from "../../lib/api.ts"

/**
 * The conventions grouped by topic, which upstream does not publish: every
 * namespace, metric and signal a domain owns, and the specification areas that
 * bind them. An agent asking "what do I need to instrument a database client"
 * gets one fetch instead of a filter over 963 rows.
 */
export const GET: APIRoute = async () => {
	const data = await catalog()
	const domains = buildDomains(data).map((domain) => ({
		slug: domain.slug,
		title: domain.title,
		blurb: domain.blurb,
		url: `/domains/${domain.slug}`,
		namespaces: domain.namespaces,
		counts: {
			attributes: domain.attributes.length,
			stable: domain.stable,
			deprecated: domain.deprecated,
			metrics: domain.metrics.length,
			spans: domain.spans.length,
			events: domain.events.length,
			entities: domain.entities.length,
		},
		attributes: domain.attributes.map(({ attribute }) => attribute.id),
		metrics: domain.metrics.map((metric) => metric.name),
		signals: [...domain.spans, ...domain.events, ...domain.entities].map((signal) => ({
			name: signal.name,
			kind: signal.kind,
			spanKind: signal.spanKind ?? null,
		})),
		governedBy: domain.governance.map((entry) => ({
			area: entry.area,
			governs: entry.what,
			requirements: entry.count,
			binding: entry.binding,
			documents: entry.documents,
		})),
	}))

	return json({
		semconvVersion: data.semconv.latest.version,
		count: domains.length,
		domains,
	})
}
