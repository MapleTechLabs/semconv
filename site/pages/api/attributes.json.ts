import type { APIRoute } from "astro"
import { catalog } from "../../../src/model/catalog.ts"
import { json } from "../../lib/api.ts"

export const GET: APIRoute = async () => {
	const data = await catalog()
	return json({
		source: "semconv",
		version: data.semconv.latest.version,
		count: data.attributes.length,
		attributes: data.attributes.map((a) => ({
			id: a.id,
			type: a.type,
			stability: a.stability,
			brief: a.brief,
			examples: a.examples,
			namespace: a.namespace,
			deprecated: a.deprecated ?? null,
		})),
	})
}
