import type { APIRoute } from "astro"
import { catalog } from "../../../src/model/catalog.ts"
import { json } from "../../lib/api.ts"

/**
 * Every RFC 2119 requirement in the current specification and in the OTLP
 * protocol document, with the section it lives in and that document's stability
 * status. This is the file to check an implementation against.
 */
export const GET: APIRoute = async () => {
	const data = await catalog()
	const collect = (source: "spec" | "proto") => {
		const snapshot = source === "spec" ? data.spec.latest : data.proto.latest
		return snapshot.sections.flatMap((section) =>
			section.normative.map((statement) => ({
				id: statement.id,
				level: statement.level,
				text: statement.text,
				section: statement.section,
				sectionTitle: section.title,
				status: section.status,
				source,
			})),
		)
	}

	const requirements = [...collect("spec"), ...collect("proto")]
	return json({
		specVersion: data.spec.latest.version,
		protoVersion: data.proto.latest.version,
		count: requirements.length,
		requirements,
	})
}
