import type { Catalog } from "../../src/model/catalog.ts"
import type { NameIndex } from "./check-names.ts"

/** Every current key in either registry, every retired one, every template prefix. */
export function buildNameIndex(data: Catalog): NameIndex {
	const all = [...data.semconv.latest.attributes, ...data.genai.latest.attributes]
	const live = new Set(all.filter((a) => !a.deprecated).map((a) => a.id))
	const deprecated: Record<string, string> = {}
	for (const a of all) {
		if (a.deprecated && !live.has(a.id)) deprecated[a.id] = a.deprecated.renamedTo ?? ""
	}
	return {
		live: [...live],
		deprecated,
		templates: all.filter((a) => a.type.startsWith("template[")).map((a) => a.id),
	}
}
