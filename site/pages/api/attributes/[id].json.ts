import type { APIRoute } from "astro"
import { catalog } from "../../../../src/model/catalog.ts"
import { json } from "../../../lib/api.ts"

export async function getStaticPaths() {
	const data = await catalog()
	return data.attributes.map((attribute) => ({ params: { id: attribute.id }, props: { attribute } }))
}

export const GET: APIRoute = async ({ props }) => {
	const data = await catalog()
	const attribute = props["attribute"] as (typeof data.attributes)[number]
	return json({
		source: "semconv",
		version: data.latest.version,
		attribute,
		history: data.lifecycle.get(attribute.id) ?? [],
		replaces: [...data.renames.entries()].filter(([, to]) => to === attribute.id).map(([from]) => from),
	})
}
