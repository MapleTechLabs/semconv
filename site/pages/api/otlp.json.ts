import type { APIRoute } from "astro"
import { catalog } from "../../../src/model/catalog.ts"
import { json } from "../../lib/api.ts"

export const GET: APIRoute = async () => {
	const data = await catalog()
	return json({
		version: data.proto.latest.version,
		count: data.proto.latest.messages.length,
		messages: data.proto.latest.messages,
	})
}
