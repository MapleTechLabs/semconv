import type { APIRoute } from "astro"
import { catalog, SOURCES } from "../../../src/model/catalog.ts"
import { json } from "../../lib/api.ts"

export const GET: APIRoute = async () => {
	const data = await catalog()
	return json({
		sources: Object.fromEntries(
			SOURCES.map((id) => {
				const source = data.source(id)
				return [
					id,
					{
						repository: `open-telemetry/${id === "semconv" ? "semantic-conventions" : id === "spec" ? "opentelemetry-specification" : "opentelemetry-proto"}`,
						latest: source.latest.version,
						versions: source.versions.map((version) => {
							const release = source.release(version)
							const diff = source.diffs.find((d) => d.to === version)
							return {
								version,
								tag: `v${version}`,
								publishedAt: release?.publishedAt ?? null,
								releaseNotes: release?.url ?? null,
								changes: diff?.counts ?? null,
							}
						}),
					},
				]
			}),
		),
	})
}
