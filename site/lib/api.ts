/**
 * Static JSON responses, minified. These are read by programs, and the full
 * pairwise diff set is large enough that indentation alone would nearly double
 * what the CDN ships.
 */
export const json = (body: unknown): Response =>
	new Response(JSON.stringify(body), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=3600",
			"access-control-allow-origin": "*",
		},
	})
