import type { APIRoute } from "astro"
import { catalog, SOURCES } from "../../../../../src/model/catalog.ts"
import type { SourceId } from "../../../../../src/model/types.ts"
import { json } from "../../../../lib/api.ts"

/**
 * Every ordered pair of tracked versions, per source, precomputed.
 *
 * Far cheaper to ship than the snapshots a client would otherwise download and
 * diff for itself, and it means the browser comparison page, the MCP tools and
 * anyone with curl all read the same bytes.
 */
export async function getStaticPaths() {
	const data = await catalog()
	const paths: { params: { source: SourceId; pair: string } }[] = []
	for (const source of SOURCES) {
		const oldestFirst = [...data.source(source).versions].reverse()
		for (let i = 0; i < oldestFirst.length; i++) {
			for (let j = i + 1; j < oldestFirst.length; j++) {
				paths.push({ params: { source, pair: `${oldestFirst[i]}...${oldestFirst[j]}` } })
			}
		}
	}
	return paths
}

export const GET: APIRoute = async ({ params }) => {
	const data = await catalog()
	const [from, to] = String(params["pair"]).split("...")
	return json(data.source(params["source"] as SourceId).diff(from as string, to as string))
}
