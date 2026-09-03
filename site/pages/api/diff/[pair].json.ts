import type { APIRoute } from "astro"
import { catalog } from "../../../../src/model/catalog.ts"
import { json } from "../../../lib/api.ts"

/**
 * Every ordered pair of tracked versions, precomputed. 16 releases is 120 diffs
 * of a few tens of kilobytes each -- far cheaper to ship than the snapshots a
 * client would otherwise have to download and diff for itself.
 */
export async function getStaticPaths() {
	const data = await catalog()
	const oldestFirst = [...data.versions].reverse()
	const paths: { params: { pair: string } }[] = []
	for (let i = 0; i < oldestFirst.length; i++) {
		for (let j = i + 1; j < oldestFirst.length; j++) {
			paths.push({ params: { pair: `${oldestFirst[i]}...${oldestFirst[j]}` } })
		}
	}
	return paths
}

export const GET: APIRoute = async ({ params }) => {
	const data = await catalog()
	const [from, to] = String(params["pair"]).split("...")
	return json(data.diff(from as string, to as string))
}
