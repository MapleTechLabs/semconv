import type { APIRoute } from "astro"
import { SITE } from "../lib/site.ts"

export const GET: APIRoute = ({ site }) =>
	new Response(
		`User-agent: *\nAllow: /\n\nSitemap: ${site?.origin ?? `https://${SITE.name}`}/sitemap.xml\n`,
		{ headers: { "content-type": "text/plain; charset=utf-8" } },
	)
