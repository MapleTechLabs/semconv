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

import { SITE } from "../site.ts"

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
			"List every tracked release of all three OpenTelemetry sources - semantic conventions, the specification, and OTLP - newest first, with publication dates and how many breaking, notable and editorial changes each one introduced.",
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
			"What changed between two tracked versions of one source. For semconv: renames, deprecations, promotions, removals, metric shape changes. For spec: RFC 2119 requirements added, dropped, moved or restrengthened. For proto: fields added, removed, renumbered or retyped. Each ranked breaking / notable / informational.",
		inputSchema: {
			type: "object",
			properties: {
				source: {
					type: "string",
					enum: ["semconv", "spec", "proto"],
					description: "Which source to diff. Default \"semconv\".",
				},
				from: { type: "string", description: "Older version, e.g. \"1.40.0\"." },
				to: { type: "string", description: "Newer version, e.g. \"1.44.0\"." },
				include_editorial: { type: "boolean", description: "Include wording-only changes. Default false." },
			},
			required: ["from", "to"],
			additionalProperties: false,
		},
	},
	{
		name: "search_requirements",
		description:
			"Search the RFC 2119 requirements of the OpenTelemetry specification and the OTLP protocol document - the sentences that actually bind an implementation. Use this to check behaviour against the spec rather than recalling it. Note the OTLP protocol spec is not in the specification repository; both are covered here.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Substring to match against requirement text, e.g. \"partial_success\"." },
				level: {
					type: "string",
					description: "Restrict to one RFC 2119 level, e.g. \"MUST\" or \"SHOULD NOT\".",
				},
				section: { type: "string", description: "Restrict to sections whose path contains this, e.g. \"trace/sdk\"." },
				limit: { type: "number", description: "Maximum results, default 40." },
			},
			additionalProperties: false,
		},
	},
	{
		name: "get_otlp_message",
		description:
			"One OTLP wire definition in full: every field with its number, type and cardinality, or every value of an enum. Field numbers are what binary OTLP keys on and field names are what OTLP/JSON keys on, so both matter.",
		inputSchema: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: "Message or enum name, fully qualified or not, e.g. \"Span\" or \"opentelemetry.proto.trace.v1.Span\".",
				},
			},
			required: ["name"],
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
			const source = String(args?.source ?? "semconv")
			const from = String(args?.from ?? "").replace(/^v/, "")
			const to = String(args?.to ?? "").replace(/^v/, "")
			const diff = await asset(env, `/api/diff/${source}/${from}...${to}.json`, origin)
			if (!diff) {
				return text({
					error: `No ${source} diff for v${from} to v${to}. Both versions must be tracked for that source, and \`from\` must be the older one - call list_versions.`,
				})
			}
			const changes = args?.include_editorial
				? diff.changes
				: diff.changes.filter((c: Json) => c.severity !== "informational")
			return text({ ...diff, changes })
		}

		case "search_requirements": {
			const all = await asset(env, "/api/requirements.json", origin)
			if (!all) return text({ error: "requirements unavailable" })
			const query = String(args?.query ?? "").toLowerCase()
			const level = args?.level ? String(args.level).toUpperCase() : undefined
			const section = args?.section ? String(args.section).toLowerCase() : undefined
			const limit = Math.min(Number(args?.limit ?? 40) || 40, 200)

			const matches = all.requirements
				.filter((r: Json) => !level || r.level === level)
				.filter((r: Json) => !section || r.section.toLowerCase().includes(section))
				.filter((r: Json) => query === "" || r.text.toLowerCase().includes(query))

			return text({
				specVersion: all.specVersion,
				protoVersion: all.protoVersion,
				matched: matches.length,
				returned: Math.min(matches.length, limit),
				requirements: matches.slice(0, limit),
			})
		}

		case "get_otlp_message": {
			const wanted = String(args?.name ?? "")
			const otlp = await asset(env, "/api/otlp.json", origin)
			if (!otlp) return text({ error: "OTLP definitions unavailable" })
			// Accept a bare name so a caller does not have to know the package path.
			const found =
				otlp.messages.find((m: Json) => m.name === wanted) ??
				otlp.messages.find((m: Json) => m.name.endsWith(`.${wanted}`))
			if (!found) {
				return text({
					error: `No OTLP message or enum named \`${wanted}\`.`,
					didYouMean: otlp.messages
						.filter((m: Json) => m.name.toLowerCase().includes(wanted.toLowerCase()))
						.slice(0, 10)
						.map((m: Json) => m.name),
				})
			}
			return text({ version: otlp.version, message: found })
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

		// One canonical host, as far as this Worker can enforce it.
		//
		// Cloudflare's asset layer answers any request that matches a file in
		// `dist/` *before* the Worker runs, so this only fires for paths with no
		// matching asset — `/mcp` and 404s. Asset paths are therefore served on
		// `www` too, and it is the `<link rel="canonical">` on every page (always
		// the apex) that keeps search engines from treating that as duplicate
		// content.
		//
		// Making the redirect absolute would mean `run_worker_first: true`, which
		// bills a Worker invocation for every asset request forever to fix a
		// cosmetic redirect. A zone-level Redirect Rule does the same job at the
		// edge for free; see the README.
		if (url.hostname.startsWith("www.")) {
			url.hostname = url.hostname.slice(4)
			return Response.redirect(url.toString(), 301)
		}

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
						serverInfo: { name: SITE.name, version: "1.0.0" },
						instructions:
							"Read-only access to the OpenTelemetry semantic conventions, specification and OTLP definitions, with their release histories. Reach for check_attribute_names before asserting that an attribute key is current, and search_requirements before asserting what the spec requires - the conventions rename keys every month and a model's training data is usually behind them. Note that the OTLP protocol specification lives in the opentelemetry-proto repository, not the specification one; both are covered.",
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
