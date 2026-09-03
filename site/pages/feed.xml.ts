import type { APIRoute } from "astro"
import { catalog, SOURCE_LABEL } from "../../src/model/catalog.ts"
import { SITE } from "../lib/site.ts"

const escape = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export const GET: APIRoute = async ({ site }) => {
	const data = await catalog()
	const origin = site?.origin ?? SITE.origin

	const items = data.feed.map(({ source, version, diff, release }) => {
		const significant = diff.changes.filter((c) => c.severity !== "informational")
		const lines = significant
			.slice(0, 30)
			.map((c) => `${c.severity.toUpperCase()} · ${c.entity} ${c.kind} · ${c.id} — ${c.detail}`)
		const body = [
			`${diff.counts.breaking} breaking, ${diff.counts.notable} notable, ${diff.counts.informational} editorial changes since v${diff.from}.`,
			...lines,
			significant.length > 30 ? `…and ${significant.length - 30} more.` : "",
		]
			.filter(Boolean)
			.join("\n")

		return `	<item>
		<title>${SOURCE_LABEL[source]} v${version} — ${diff.counts.breaking} breaking, ${diff.counts.notable} notable</title>
		<link>${origin}/releases/${source}/${version}</link>
		<guid isPermaLink="true">${origin}/releases/${source}/${version}</guid>
		<pubDate>${new Date(release?.publishedAt ?? Date.now()).toUTCString()}</pubDate>
		<description>${escape(body)}</description>
	</item>`
	})

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
	<title>${SITE.name} — ${SITE.tagline}</title>
	<link>${origin}</link>
	<description>${escape(SITE.description)}</description>
	<language>en</language>
${items.join("\n")}
</channel>
</rss>
`

	return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8" } })
}
