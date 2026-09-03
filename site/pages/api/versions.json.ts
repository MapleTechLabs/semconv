import type { APIRoute } from "astro"
import { catalog } from "../../../src/model/catalog.ts"
import { json } from "../../lib/api.ts"

export const GET: APIRoute = async () => {
	const data = await catalog()
	return json({
		source: "semconv",
		latest: data.latest.version,
		versions: data.versions.map((version) => {
			const release = data.releases.find((r) => r.version === version)
			const diff = data.diffs.find((d) => d.to === version)
			return {
				version,
				tag: `v${version}`,
				publishedAt: release?.publishedAt ?? null,
				releaseNotes: release?.url ?? null,
				changes: diff?.counts ?? null,
			}
		}),
	})
}
