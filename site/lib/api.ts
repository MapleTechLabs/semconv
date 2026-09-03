/**
 * Static JSON responses, minified. These are read by programs, and the full
 * pairwise diff set is large enough that indentation alone would nearly double
 * what the CDN ships.
 *
 * The headers below only take effect under `astro preview`. In production
 * Cloudflare serves `dist/` through its asset layer, which discards them — the
 * deployed CORS and caching rules live in `public/_headers`. Keep the two in
 * step, or the API works locally and is unreachable cross-origin in production.
 */
export const json = (body: unknown): Response =>
	new Response(JSON.stringify(body), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=3600",
			"access-control-allow-origin": "*",
		},
	})
