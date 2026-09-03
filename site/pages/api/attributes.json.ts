import type { APIRoute } from "astro"
import { catalog } from "../../../src/model/catalog.ts"
import { json } from "../../lib/api.ts"

/**
 * Every attribute across both registries, each tagged with which one it came
 * from.
 *
 * The overlap is the interesting part and the reason they are served together:
 * v1.44.0 moved the whole `gen_ai.*` namespace out to its own repository, so
 * `gen_ai.request.model` is present in semantic-conventions marked deprecated
 * ("Moved to...") *and* in the GenAI conventions as a current definition.
 * Anything answering "is this key still good" has to see both, or it reports a
 * live attribute as dead.
 *
 * `source`/`version` at the top level are the semantic-conventions ones and are
 * kept as they were, so consumers written against the earlier shape still work.
 */
export const GET: APIRoute = async () => {
	const data = await catalog()

	// `data.semconv` / `data.genai` rather than `data.source(id)`: only these two
	// carry a registry, and the typed accessors keep that visible.
	const entry = (registry: "semconv" | "genai") =>
		(registry === "semconv" ? data.semconv : data.genai).latest.attributes.map((a) => ({
			id: a.id,
			registry,
			type: a.type,
			stability: a.stability,
			brief: a.brief,
			examples: a.examples,
			namespace: a.namespace,
			deprecated: a.deprecated ?? null,
		}))

	const attributes = [...entry("semconv"), ...entry("genai")]

	return json({
		source: "semconv",
		version: data.semconv.latest.version,
		registries: {
			semconv: { version: data.semconv.latest.version, released: true },
			genai: { version: data.genai.latest.version, released: false },
		},
		count: attributes.length,
		attributes,
	})
}
