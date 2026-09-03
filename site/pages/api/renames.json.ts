import type { APIRoute } from "astro"
import { catalog } from "../../../src/model/catalog.ts"
import { json } from "../../lib/api.ts"

/**
 * The single most useful file here: every attribute the registry has deprecated
 * in favour of another name, and the release that did it. Small enough for an
 * agent to hold in context while auditing a codebase.
 */
export const GET: APIRoute = async () => {
	const data = await catalog()
	const renames = [...data.renames.entries()].map(([from, to]) => {
		const event = (data.lifecycle.get(from) ?? []).find((e) => e.kind === "renamed")
		return { from, to, since: event?.version ?? null }
	})
	return json({
		source: "semconv",
		version: data.latest.version,
		count: renames.length,
		renames: renames.sort((a, b) => a.from.localeCompare(b.from)),
	})
}
