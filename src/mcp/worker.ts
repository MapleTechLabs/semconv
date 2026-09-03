/**
 * A public, read-only MCP endpoint over the same static JSON the site ships.
 *
 * There is no database and no origin logic: every tool is a fetch of an asset
 * this Worker is already serving, through the `ASSETS` binding. That keeps the
 * MCP surface and the browsable site definitionally in sync -- if a page is
 * right, the tool answering the same question is right.
 *
 * Transport is streamable HTTP answering with a single JSON body per request.
 * The server holds no session state, so there is nothing for a client to
 * resume and no SSE stream to keep open.
 */

interface Env {
	ASSETS: { fetch: (request: Request) => Promise<Response> }
}

interface JsonRpcRequest {
	jsonrpc: "2.0"
	id?: string | number | null
	method: string
	params?: Record<string, unknown>
}

const PROTOCOL_VERSION = "2025-06-18"

const TOOLS = [
	{
		name: "list_versions",
		description:
			"List every tracked release of the OpenTelemetry semantic conventions, newest first, with publication dates and how many breaking, notable and editorial changes each one introduced.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "check_attribute_names",
		description:
			"Given attribute keys a codebase emits or queries, report which are deprecated, renamed, or absent from the OpenTelemetry semantic conventions. Use this to audit instrumentation rather than guessing from memory - the registry moves every month.",
		inputSchema: {
			type: "object",
			properties: {
				names: {
					type: "array",
					items: { type: "string" },
					description: "Attribute keys, e.g. [\"db.statement\", \"deployment.environment\"]. Up to 200.",
				},
			},
			required: ["names"],
			additionalProperties: false,
		},
	},
	{
		name: "get_attribute",
		description:
			"Full definition of one semantic-conventions attribute: type, stability, guidance note, examples, which signals carry it, and its release-by-release history.",
		inputSchema: {
			type: "object",
			properties: { id: { type: "string", description: "Attribute id, e.g. \"db.query.text\"." } },
			required: ["id"],
			additionalProperties: false,
		},
	},
	{
		name: "search_attributes",
		description:
			"Search the semantic-conventions attribute registry by substring against ids and descriptions, optionally narrowed to a namespace or to deprecated entries only.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Substring to match against attribute ids and briefs." },
				namespace: { type: "string", description: "Restrict to one namespace, e.g. \"db\" or \"k8s\"." },
				deprecated_only: { type: "boolean", description: "Only return deprecated attributes." },
				limit: { type: "number", description: "Maximum results, default 50." },
			},
			additionalProperties: false,
		},
	},
	{
		name: "diff_versions",
		description:
			"What changed in the semantic conventions between two tracked versions: renames, deprecations, stability promotions, removals and metric shape changes, each ranked breaking / notable / informational.",
		inputSchema: {
			type: "object",
			properties: {
				from: { type: "string", description: "Older version, e.g. \"1.40.0\"." },
				to: { type: "string", description: "Newer version, e.g. \"1.44.0\"." },
				include_editorial: { type: "boolean", description: "Include wording-only changes. Default false." },
			},
			required: ["from", "to"],
			additionalProperties: false,
		},
	},
] as const

// biome-ignore lint: JSON from our own static assets, narrowed at each use.
type Json = any

const asset = async (env: Env, path: string, origin: string): Promise<Json | null> => {
	const response = await env.ASSETS.fetch(new Request(`${origin}${path}`))
	if (!response.ok) return null
	return (await response.json()) as Json
}

const text = (value: unknown) => ({
	content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, "\t") }],
})

async function callTool(name: string, args: Json, env: Env, origin: string) {
	switch (name) {
		case "list_versions":
			return text((await asset(env, "/api/versions.json", origin)) ?? { error: "unavailable" })

		case "check_attribute_names": {
			const names: string[] = Array.isArray(args?.names) ? args.names.slice(0, 200).map(String) : []
			if (names.length === 0) return text({ error: "`names` must be a non-empty array of attribute keys." })

			const registry = await asset(env, "/api/attributes.json", origin)
			if (!registry) return text({ error: "registry unavailable" })
			const byId = new Map<string, Json>(registry.attributes.map((a: Json) => [a.id, a]))

			const results = names.map((name) => {
				const attribute = byId.get(name)
				if (!attribute) {
					// Template attributes are defined as a prefix (`http.request.header`)
					// and used with a key appended, so an exact miss is not proof of absence.
					const prefix = registry.attributes.find(
						(a: Json) => a.type.startsWith("template[") && name.startsWith(`${a.id}.`),
					)
					return prefix
						? { name, status: "ok", note: `Matches the template attribute \`${prefix.id}\`.` }
						: { name, status: "unknown", note: "Not defined in the registry. It may be a custom attribute." }
				}
				if (attribute.deprecated?.renamedTo) {
					return {
						name,
						status: "renamed",
						replacement: attribute.deprecated.renamedTo,
						note: `Renamed to \`${attribute.deprecated.renamedTo}\`. The old key still resolves, so consumers usually read both.`,
					}
				}
				if (attribute.deprecated) {
					return {
						name,
						status: "deprecated",
						note: attribute.deprecated.note ?? `Deprecated (${attribute.deprecated.reason}); no replacement defined.`,
					}
				}
				return { name, status: "ok", stability: attribute.stability, type: attribute.type }
			})

			// "unknown" is deliberately not counted as needing attention: a
			// vendor-namespaced key is supposed to be absent from the registry, and
			// lumping it in with real deprecations would train the caller to ignore
			// the count.
			const needsAttention = results.filter((r) => r.status === "renamed" || r.status === "deprecated").length
			return text({
				version: registry.version,
				checked: results.length,
				needsAttention,
				notInRegistry: results.filter((r) => r.status === "unknown").length,
				results,
			})
		}

		case "get_attribute": {
			const id = String(args?.id ?? "")
			const found = await asset(env, `/api/attributes/${encodeURIComponent(id)}.json`, origin)
			return text(found ?? { error: `No attribute \`${id}\` in the registry.` })
		}

		case "search_attributes": {
			const registry = await asset(env, "/api/attributes.json", origin)
			if (!registry) return text({ error: "registry unavailable" })
			const query = String(args?.query ?? "").toLowerCase()
			const namespace = args?.namespace ? String(args.namespace) : undefined
			const limit = Math.min(Number(args?.limit ?? 50) || 50, 200)

			const matches = registry.attributes
				.filter((a: Json) => !namespace || a.namespace === namespace)
				.filter((a: Json) => !args?.deprecated_only || a.deprecated)
				.filter((a: Json) => query === "" || `${a.id} ${a.brief}`.toLowerCase().includes(query))

			return text({
				version: registry.version,
				matched: matches.length,
				returned: Math.min(matches.length, limit),
				attributes: matches.slice(0, limit),
			})
		}

		case "diff_versions": {
			const from = String(args?.from ?? "").replace(/^v/, "")
			const to = String(args?.to ?? "").replace(/^v/, "")
			const diff = await asset(env, `/api/diff/${from}...${to}.json`, origin)
			if (!diff) {
				return text({
					error: `No diff for v${from} to v${to}. Versions must both be tracked, and \`from\` must be the older one - call list_versions.`,
				})
			}
			const changes = args?.include_editorial
				? diff.changes
				: diff.changes.filter((c: Json) => c.severity !== "informational")
			return text({ ...diff, changes })
		}

		default:
			return text({ error: `Unknown tool \`${name}\`.` })
	}
}

const rpc = (id: JsonRpcRequest["id"], result: unknown) => ({ jsonrpc: "2.0" as const, id: id ?? null, result })

const rpcError = (id: JsonRpcRequest["id"], code: number, message: string) => ({
	jsonrpc: "2.0" as const,
	id: id ?? null,
	error: { code, message },
})

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type, mcp-protocol-version, mcp-session-id",
}

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...CORS },
	})

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url)

		if (url.pathname !== "/mcp") return env.ASSETS.fetch(request)
		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS })
		if (request.method !== "POST") {
			return jsonResponse({ error: "This MCP endpoint accepts POST with a JSON-RPC body." }, 405)
		}

		let body: JsonRpcRequest
		try {
			body = (await request.json()) as JsonRpcRequest
		} catch {
			return jsonResponse(rpcError(null, -32700, "Parse error"), 400)
		}

		switch (body.method) {
			case "initialize":
				return jsonResponse(
					rpc(body.id, {
						protocolVersion: PROTOCOL_VERSION,
						capabilities: { tools: {} },
						serverInfo: { name: "semconv.watch", version: "1.0.0" },
						instructions:
							"Read-only access to the OpenTelemetry semantic conventions and their release history. Reach for check_attribute_names before asserting that an attribute key is current - the registry deprecates and renames keys every month, and a model's training data is usually behind it.",
					}),
				)

			// Notifications carry no id and expect no result, only an acknowledgement.
			case "notifications/initialized":
				return new Response(null, { status: 202, headers: CORS })

			case "tools/list":
				return jsonResponse(rpc(body.id, { tools: TOOLS }))

			case "tools/call": {
				const params = (body.params ?? {}) as { name?: string; arguments?: Json }
				if (!params.name) return jsonResponse(rpcError(body.id, -32602, "Missing tool name"))
				const result = await callTool(params.name, params.arguments ?? {}, env, url.origin)
				return jsonResponse(rpc(body.id, result))
			}

			case "ping":
				return jsonResponse(rpc(body.id, {}))

			default:
				return jsonResponse(rpcError(body.id, -32601, `Method not found: ${body.method}`))
		}
	},
}
