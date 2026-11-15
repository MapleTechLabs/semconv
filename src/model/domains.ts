import type { Catalog } from "./catalog.ts"
import type { Change } from "./change.ts"
import type { Attribute, MetricDef, NormativeStatement, ProtoMessage, SignalDef, SpecSection } from "./types.ts"

/**
 * The topic layer the four repositories do not have.
 *
 * Upstream splits its work by artefact — a registry of attributes here, prose
 * there, `.proto` files somewhere else — but nobody arrives asking "what is in
 * the registry". They arrive asking about databases, or about HTTP. The pivot
 * that makes that answerable already exists in the data: attributes carry a
 * namespace, metrics and signals are named with the same prefixes, and the
 * specification divides into areas that govern the signal kinds a topic uses.
 *
 * The grouping itself is the one editorial judgement here. It is a hand-written
 * map of every namespace the registry currently defines, and a test fails if a
 * release introduces one this file has not placed.
 */

export interface DomainDef {
	readonly slug: string
	readonly title: string
	/** One sentence, shown on the directory and at the top of the domain page. */
	readonly blurb: string
	/** Attribute namespaces this domain owns. Every namespace belongs to exactly one. */
	readonly namespaces: readonly string[]
	/** Metric and signal prefixes with no attribute namespace of their own. */
	readonly aliases?: readonly string[]
	/**
	 * Matched case-insensitively, on word boundaries, against requirement text
	 * and section titles. Kept deliberately narrow: a domain page showing forty
	 * loosely-related requirements is worse than one showing six real ones.
	 */
	readonly keywords?: readonly string[]
	/**
	 * Rules that bind this domain but live in prose, not in the registry, so the
	 * signal and attribute lists alone would miss them. Each one cites its source.
	 */
	readonly rules?: DomainRules
	/** Set when the domain is an OTLP signal of its own. */
	readonly wire?: DomainWire
}

/**
 * A domain that is a signal, not a subject carried on spans, metrics or events.
 * The registry has no signal entries for it: what it emits is defined by its own
 * specification area and its own `.proto` package.
 */
export interface DomainWire {
	/** Directory under `specification/` that governs the signal. */
	readonly area: string
	/** "Profiles": what that area governs. */
	readonly what: string
	/** Proto packages, data model first, then the collector service. */
	readonly packages: readonly string[]
	/** Fully qualified gRPC service; its one method is `Export`. */
	readonly grpcService: string
	/** Default OTLP/HTTP path. */
	readonly httpPath: string
}

export interface DomainRule {
	readonly title: string
	/** The strongest keyword in the upstream sentence. */
	readonly level: "MUST" | "MUST NOT" | "SHOULD" | "SHOULD NOT" | "MAY"
	/** Markdown with inline code, rendered through `inlineCode`. */
	readonly text: string
	/** Heading anchor in the document, or a line range (`L107-L112`) in a `.proto` file. */
	readonly anchor: string
	/** The document this rule paraphrases, when it is not `DomainRules.doc`. */
	readonly doc?: string
}

export interface DomainRules {
	/** Absolute URL of the upstream document the rules paraphrase. */
	readonly doc: string
	/** Where the rules live upstream, completing "these rules live in ...". */
	readonly where?: string
	readonly items: readonly DomainRule[]
}

/** The document a rule links to. */
export const ruleUrl = (rules: DomainRules, rule: DomainRule) => `${rule.doc ?? rules.doc}#${rule.anchor}`

/** Every document a domain's rules paraphrase, the default one first. */
export const ruleDocs = (rules: DomainRules): readonly string[] => [
	...new Set([rules.doc, ...rules.items.flatMap((rule) => (rule.doc ? [rule.doc] : []))]),
]

/** The GenAI registry is unreleased, so its prose is cited from the default branch. */
const GENAI_MCP_DOC = "https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/mcp.md"

/**
 * The profiles rules are pinned to the releases they were written against, so
 * each link shows the text it paraphrases even after upstream moves on.
 */
const PROTO_AT = "https://github.com/open-telemetry/opentelemetry-proto/blob/v1.11.1"
const PROFILES_PROTO = `${PROTO_AT}/opentelemetry/proto/profiles/v1development/profiles.proto`
const COMMON_PROTO = `${PROTO_AT}/opentelemetry/proto/common/v1/common.proto`
/** The development version header is merged but in no release yet. */
const OTLP_SPEC_MAIN = "https://github.com/open-telemetry/opentelemetry-proto/blob/main/docs/specification.md"
const SEMCONV_PROFILES_DOC = "https://github.com/open-telemetry/semantic-conventions/blob/v1.44.0/docs/general/profiles.md"
const SPEC_MAPPINGS_DOC = "https://github.com/open-telemetry/opentelemetry-specification/blob/v1.62.0/specification/profiles/mappings.md"

export const DOMAINS: readonly DomainDef[] = [
	{
		slug: "database",
		title: "Databases",
		blurb: "Client calls to SQL and NoSQL stores: the query, the operation, the collection, and the connection pool behind them.",
		namespaces: ["db", "cassandra", "elasticsearch", "oracle", "pool"],
		keywords: ["database", "SQL"],
	},
	{
		slug: "http",
		title: "HTTP and the web",
		blurb: "Client and server HTTP calls, the URL they address, and the browser that made them.",
		namespaces: ["http", "url", "user_agent", "browser", "webengine", "graphql"],
		keywords: ["HTTP", "status code", "request header"],
	},
	{
		slug: "rpc",
		title: "RPC",
		blurb: "Remote procedure calls: gRPC, JSON-RPC, ONC RPC and the framework layers on top of them.",
		namespaces: ["rpc", "jsonrpc", "onc_rpc", "signalr"],
		keywords: ["RPC", "gRPC"],
	},
	{
		slug: "messaging",
		title: "Messaging",
		blurb: "Queues, topics and brokers — producing, receiving, processing and settling a message.",
		namespaces: ["messaging", "message", "cloudevents"],
		keywords: ["messaging", "message queue"],
	},
	{
		slug: "gen-ai",
		title: "Generative AI",
		blurb: "Model calls, agents, tools and A2A. Split into its own repository in v1.44.0 and still unreleased.",
		namespaces: ["gen_ai", "openai", "a2a"],
		aliases: ["anthropic"],
		keywords: ["GenAI", "LLM"],
	},
	{
		slug: "mcp",
		title: "Model Context Protocol",
		blurb: "MCP clients and servers: tool calls, prompts, resources and sessions over JSON-RPC, on stdio or Streamable HTTP. Defined in the GenAI registry.",
		namespaces: ["mcp"],
		keywords: ["MCP", "Model Context Protocol"],
		rules: {
			doc: GENAI_MCP_DOC,
			items: [
				{
					title: "Propagate context in the message, not the transport",
					level: "SHOULD",
					text: "Inject the trace context into the request's `params._meta`, using the unprefixed keys `traceparent`, `tracestate` and `baggage` (SEP-414). The receiver extracts it from there and uses it as the remote parent.",
					anchor: "context-propagation",
				},
				{
					title: "The transport span is a link, not the parent",
					level: "SHOULD",
					text: "One Streamable HTTP request can carry several MCP messages, and one message can span several HTTP requests on retry. The server span takes its parent from `params._meta` and links the ambient (HTTP) context if there is one.",
					anchor: "context-propagation",
				},
				{
					title: "Name spans after the method and its target",
					level: "SHOULD",
					text: "`{mcp.method.name} {target}`, where the target is `gen_ai.tool.name` or `gen_ai.prompt.name`: `tools/call get-weather`. With no low-cardinality target, just `{mcp.method.name}`. `mcp.resource.uri` goes in the name only when a user opts in.",
					anchor: "client",
				},
				{
					title: "A tool that returns isError is a tool_error",
					level: "SHOULD",
					text: "A `CallToolResult` with `isError: true` is a successful JSON-RPC call, so it carries no error code. Set `error.type` to `tool_error`. A JSON-RPC error sets `rpc.response.status_code` and `error.type` to the code; an HTTP failure without one uses the HTTP status code.",
					anchor: "client",
				},
				{
					title: "The caller's mistakes are not server errors",
					level: "SHOULD NOT",
					text: "On the server, `-32700`, `-32600`, `-32601`, `-32602` (including an unknown tool) and `-32002` mean the caller sent something the server could not serve. They are not errors on the server span; every other code is.",
					anchor: "server",
				},
				{
					title: "One span per tool call",
					level: "SHOULD NOT",
					text: "If GenAI instrumentation already traces the tool execution, the MCP client adds its attributes to that `execute_tool` span instead of creating another. Set `gen_ai.operation.name` to `execute_tool` on tool calls only.",
					anchor: "client",
				},
				{
					title: "MCP conventions over RPC ones",
					level: "SHOULD",
					text: "MCP is JSON-RPC, but the RPC and HTTP conventions miss the messages inside a streaming call. Use `mcp.method.name` rather than `rpc.method`.",
					anchor: "semantic-conventions-for-model-context-protocol-mcp",
				},
				{
					title: "Duration buckets from 10 ms to 5 minutes",
					level: "SHOULD",
					text: "The operation and session duration histograms are in seconds, with explicit bucket boundaries `[0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 30, 60, 120, 300]`.",
					anchor: "metrics",
				},
				{
					title: "Arguments and results are opt-in",
					level: "MAY",
					text: "`gen_ai.tool.call.arguments`, `gen_ai.tool.call.result` and prompt arguments (`gen_ai.prompt.variable.<name>`) may hold sensitive data, so they are recorded only when a user opts in.",
					anchor: "client",
				},
			],
		},
	},
	{
		slug: "cloud",
		title: "Cloud and serverless",
		blurb: "Where the code runs: the provider, the region, the account, and the function invoking it.",
		namespaces: ["cloud", "aws", "azure", "az", "gcp", "heroku", "cloudfoundry", "oracle_cloud", "faas"],
		aliases: ["dynamodb"],
		keywords: ["cloud provider", "FaaS", "serverless"],
	},
	{
		slug: "kubernetes",
		title: "Kubernetes and containers",
		blurb: "Pods, nodes, workloads and the container runtime underneath them — the largest namespace in the registry.",
		namespaces: ["k8s", "container", "openshift", "oci"],
		keywords: ["Kubernetes", "container"],
	},
	{
		slug: "infrastructure",
		title: "Hosts and hardware",
		blurb: "The machine: its operating system, CPU, disks, filesystems and physical hardware sensors.",
		namespaces: ["host", "system", "cpu", "disk", "hw", "os", "linux", "mainframe", "zos", "file", "nfs"],
		keywords: ["operating system", "hardware"],
	},
	{
		slug: "network",
		title: "Network",
		blurb: "Addresses, ports, transports and TLS — the connection every client and server span sits on.",
		namespaces: ["network", "net", "dns", "tls", "source", "destination", "peer", "client", "server", "geo"],
		keywords: ["network", "socket", "TCP"],
	},
	{
		slug: "runtime",
		title: "Runtimes and processes",
		blurb: "Processes, threads, language runtimes and the code that raised the telemetry.",
		namespaces: [
			"process",
			"thread",
			"code",
			"jvm",
			"go",
			"nodejs",
			"v8js",
			"cpython",
			"dotnet",
			"aspnetcore",
		],
		aliases: ["kestrel", "cli"],
		keywords: ["process"],
	},
	{
		slug: "profiling",
		title: "Profiling",
		blurb: "The fourth signal: sampled stack traces and what they cost, in a format derived from pprof. Alpha in the specification, and on the wire still a development package with no compatibility promise.",
		namespaces: ["profile", "pprof"],
		keywords: ["profile", "profiles", "profiling"],
		wire: {
			area: "profiles",
			what: "Profiles",
			packages: ["opentelemetry.proto.profiles.v1development", "opentelemetry.proto.collector.profiles.v1development"],
			grpcService: "opentelemetry.proto.collector.profiles.v1development.ProfilesService",
			httpPath: "/v1development/profiles",
		},
		rules: {
			doc: PROFILES_PROTO,
			where: "comments in the `.proto` files, the OTLP specification and the convention's prose, not in the registry",
			items: [
				{
					title: "Index 0 of every dictionary table is the zero value",
					level: "MUST",
					text: "Each table in `ProfilesDictionary` starts with its zero value (`\"\"` in `string_table`, `Location{}` in `location_table`), so an index of `0` means not set. For `link_table[0]`, prefer 16 and 8 zero bytes over empty ids: some codecs expect the full lengths.",
					anchor: "L107-L112",
				},
				{
					title: "No duplicate or orphaned dictionary entries",
					level: "SHOULD NOT",
					text: "A dictionary item's identity is its value. A producer that does emit duplicates gives them no meaning by index or order, and a processor may remove duplicates and unreferenced items without consumers noticing.",
					anchor: "L114-L122",
				},
				{
					title: "A sample carries values, timestamps, or both in step",
					level: "MUST",
					text: "At least one entry in `values` or `timestamps_unix_nano`. With both, the two arrays have the same length and the same index is the same event. With timestamps only, each one counts as a value of 1.",
					anchor: "L465-L478",
				},
				{
					title: "One sample per identity",
					level: "SHOULD",
					text: "A sample's identity is `{stack_index, set_of(attribute_indices), link_index}`. Samples that share it are combined by appending to `values` and `timestamps_unix_nano`, and every sample in a profile uses the same shape.",
					anchor: "L469-L489",
				},
				{
					title: "A mapping names its binary by build id",
					level: "MUST",
					text: "Every `Mapping` carries at least one of `process.executable.build_id.gnu`, `process.executable.build_id.go` and `process.executable.build_id.htlhash`, and all three where possible. `htlhash` is recommended on every mapping because it needs no build id in the binary: the first 16 bytes of a SHA-256 over the file's first and last 4096 bytes and its length.",
					anchor: "attributes",
					doc: SPEC_MAPPINGS_DOC,
				},
				{
					title: "Attribute keys stay unique where they are referenced",
					level: "MUST",
					text: "`attribute_table` may hold several entries with the same key, but the `attribute_indices` of one message cannot point at two of them. Keep sample attributes to bounded cardinality: a value unique to every sample defeats the dictionary.",
					anchor: "L168-L189",
				},
				{
					title: "Resource and scope attributes may point into the string table",
					level: "MUST NOT",
					text: "Since v1.10.0 a `KeyValue` in a profiles request can carry `key_strindex` in place of `key`, and an `AnyValue` `string_value_strindex` in place of the string. Never set both. A receiver that reads only the inline fields sees empty keys.",
					anchor: "L77-L100",
					doc: COMMON_PROTO,
				},
				{
					title: "The original payload travels with its format",
					level: "MUST",
					text: "`original_payload` and `original_payload_format` are set together or both left unset. The known formats are `pprof`, `jfr` and `linux_perf`. Use it when the source carries what this format cannot represent without loss.",
					anchor: "L398-L416",
				},
				{
					title: "A version header guards the development format",
					level: "MUST",
					text: "Merged after v1.11.1 and in no release yet. The request names its format in `OTLP-Profiles-Development-Version` (`otlp-profiles-development-version` on gRPC). Version `1` may omit it; later versions send it. A server rejects a version it does not support before decoding, with HTTP `400` or `INVALID_ARGUMENT`, and the client drops the data without retrying.",
					anchor: "profiles-development-version",
					doc: OTLP_SPEC_MAIN,
				},
				{
					title: "Name the most precise frame type",
					level: "MUST",
					text: "`profile.frame.type` uses a well-known value whenever one applies. `native` covers C, C++, Go and Rust frames, but a more precise value such as `go` or `rust` wins when the profiler can tell.",
					anchor: "frame-types",
					doc: SEMCONV_PROFILES_DOC,
				},
				{
					title: "pprof sample type attributes sit on the scope",
					level: "MUST",
					text: "`pprof.scope.default_sample_type` and `pprof.scope.sample_type_order` exist so a profile converts back to pprof without loss. When present they are scope attributes, not profile or sample ones.",
					anchor: "compatibility-with-pprof",
					doc: SEMCONV_PROFILES_DOC,
				},
			],
		},
	},
	{
		slug: "cicd",
		title: "CI/CD and source control",
		blurb: "Pipelines, repositories, test runs and the artefacts and deployments they produce.",
		namespaces: ["cicd", "vcs", "test", "artifact", "deployment"],
		keywords: ["version control"],
	},
	{
		slug: "apps",
		title: "Apps, devices and users",
		blurb: "Mobile and desktop clients: the app, the device it runs on, the session, and who is using it.",
		namespaces: ["app", "android", "ios", "device", "session", "enduser", "user", "feature_flag", "security_rule"],
		keywords: ["feature flag", "end user"],
	},
	{
		slug: "errors",
		title: "Errors and exceptions",
		blurb: "The two namespaces every other domain reaches for when a call fails, and the rules for recording them.",
		namespaces: ["error", "exception"],
		keywords: ["exception", "error handling"],
	},
	{
		slug: "telemetry",
		title: "Telemetry and the SDK",
		blurb: "Telemetry describing itself: the service and SDK that emitted it, and the log and event plumbing.",
		namespaces: ["otel", "telemetry", "service", "log", "event", "opentracing", "state"],
		keywords: ["instrumentation scope", "schema URL", "exporter"],
	},
]

const BY_NAMESPACE = new Map<string, DomainDef>()
for (const domain of DOMAINS) {
	for (const name of [...domain.namespaces, ...(domain.aliases ?? [])]) BY_NAMESPACE.set(name, domain)
}

export const domainForNamespace = (namespace: string): DomainDef | undefined => BY_NAMESPACE.get(namespace)

export const domainBySlug = (slug: string): DomainDef | undefined => DOMAINS.find((d) => d.slug === slug)

/** `db.client.operation.duration` -> `db`, the same segment `namespace` holds. */
export const prefixOf = (name: string): string => name.split(".")[0] ?? name

/**
 * Which part of the specification binds a signal of this kind. Semantic
 * conventions never restate these rules, so a domain page has to point at them
 * or it is only half the answer.
 */
const AREA_FOR_SIGNAL: Record<string, { readonly area: string; readonly what: string }> = {
	span: { area: "trace", what: "Spans" },
	metric: { area: "metrics", what: "Metrics" },
	event: { area: "logs", what: "Events" },
	entity: { area: "entities", what: "Entities" },
}

/** Proto files carrying each signal kind on the wire. */
const PROTO_FOR_SIGNAL: Record<string, string> = {
	span: "opentelemetry/proto/trace/v1/trace.proto",
	metric: "opentelemetry/proto/metrics/v1/metrics.proto",
	event: "opentelemetry/proto/logs/v1/logs.proto",
	entity: "opentelemetry/proto/resource/v1/resource.proto",
}

/** One attribute on one signal, with how strongly that signal asks for it. */
export interface SignalAttribute {
	readonly id: string
	readonly level: string
}

export interface DomainRequirement {
	readonly statement: NormativeStatement
	readonly section: SpecSection
}

/** One area of the specification that binds this domain, and how much of it does. */
export interface Governance {
	readonly area: string
	/** "Spans", "Metrics" — what of this domain the area governs. */
	readonly what: string
	readonly count: number
	readonly documents: number
	readonly binding: number
	readonly protoFile?: string
}

/** One proto release, and what it did to a signal's wire definitions. */
export interface WireRelease {
	readonly version: string
	readonly publishedAt: string
	/** Removals, renumberings and retypings: what an older peer misdecodes. */
	readonly incompatible: readonly Change[]
	/** Additions and wording, which an older peer survives. */
	readonly compatible: readonly Change[]
}

export interface DomainWireData {
	readonly def: DomainWire
	/** Messages, enums and the service in the signal's packages, data model first. */
	readonly messages: readonly ProtoMessage[]
	/** Every tracked proto release, newest first. */
	readonly history: readonly WireRelease[]
	/** The newest release that changed the wire format incompatibly. */
	readonly lastIncompatible?: WireRelease
}

export interface RegistryEntry {
	readonly attribute: Attribute
	readonly registry: "semconv" | "genai"
}

export interface Domain {
	readonly def: DomainDef
	readonly slug: string
	readonly title: string
	readonly blurb: string
	readonly namespaces: readonly { readonly name: string; readonly count: number }[]
	readonly attributes: readonly RegistryEntry[]
	readonly metrics: readonly MetricDef[]
	readonly spans: readonly SignalDef[]
	readonly events: readonly SignalDef[]
	readonly entities: readonly SignalDef[]
	/** Signal id -> its attributes, most strongly required first. */
	readonly signalAttributes: ReadonlyMap<string, readonly SignalAttribute[]>
	readonly deprecated: number
	readonly stable: number
	/** Requirements naming this domain, strongest and most stable first. */
	readonly requirements: readonly DomainRequirement[]
	readonly governance: readonly Governance[]
	/** Recent semantic-conventions changes to anything in this domain. */
	readonly changes: readonly { readonly version: string; readonly change: Change }[]
	readonly wire?: DomainWireData
}

/**
 * Both registries as one list. 59 ids appear in each — deprecated stubs in
 * semantic-conventions pointing at the GenAI registry, where they are current —
 * so the GenAI definition wins and the semconv stub is dropped. Showing the stub
 * instead would tell a reader an attribute they use every day is dead.
 */
export function registryAttributes(data: Catalog): readonly RegistryEntry[] {
	return [
		...data.attributes.map((attribute) => ({ attribute, registry: "semconv" as const })),
		...data.genai.latest.attributes.map((attribute) => ({ attribute, registry: "genai" as const })),
	].filter(({ attribute, registry }) => registry === "genai" || !data.genaiLive.has(attribute.id))
}

const LEVEL_WEIGHT = (level: string) => (level.startsWith("MUST") || level.startsWith("SHALL") ? 0 : level.startsWith("SHOULD") ? 1 : 2)

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Documents about carrying telemetry, not about producing it. "HTTP" matches
 * every OTLP/HTTP exporter and receiver rule in these, which is a true keyword
 * hit and a useless answer: someone reading the HTTP domain wants to instrument
 * a client, not construct an exporter endpoint URL or size-limit a request body.
 *
 * `docs/` is the proto repository's OTLP specification, which is folded into the
 * same section list — most of the noise lives there, not in the specification
 * repository, so matching only on `specification/` paths misses it.
 */
const TRANSPORT_DOCS = /^(?:specification\/(?:protocol|compatibility)\/|docs\/)|sdk_exporters\//

function keywordMatcher(keywords: readonly string[]): RegExp | undefined {
	if (keywords.length === 0) return undefined
	return new RegExp(`\\b(?:${keywords.map(escapeRegex).join("|")})\\b`, "i")
}

const LEVEL_ORDER = ["required", "conditionally_required", "recommended", "opt_in"]

/** Signal ids are spelled with and without their `span.`/`event.` prefix upstream. */
const signalKey = (signal: SignalDef) => signal.id.replace(/^(span|event|entity)\./, "")

/**
 * Metrics and signals moved to the GenAI registry stay behind in semantic-conventions
 * as stubs, the same as attributes do. The GenAI copy comes last, so it wins.
 */
function latestWins<T>(items: readonly T[], key: (item: T) => string): readonly T[] {
	return [...new Map(items.map((item) => [key(item), item])).values()]
}

export function buildDomains(data: Catalog): readonly Domain[] {
	const entries = registryAttributes(data)
	const specSections = [...data.spec.latest.sections, ...data.proto.latest.sections]

	/**
	 * How strongly each group asks for each attribute. Only the attribute knows
	 * this — a `SignalDef` lists ids and nothing else — so the edge has to be
	 * rebuilt from the other side.
	 */
	const levels = new Map<string, Map<string, string>>()
	for (const { attribute } of entries) {
		for (const use of attribute.usedBy) {
			const group = levels.get(use.groupId) ?? new Map<string, string>()
			const existing = group.get(attribute.id)
			// A group can reference the same attribute twice at different levels;
			// the stronger one is what an implementer is held to.
			if (!existing || LEVEL_ORDER.indexOf(use.requirementLevel) < LEVEL_ORDER.indexOf(existing)) {
				group.set(attribute.id, use.requirementLevel)
			}
			levels.set(use.groupId, group)
		}
	}

	/** Signal ids are spelled with and without their `span.`/`event.` prefix upstream. */
	const attributesFor = (signal: SignalDef): readonly SignalAttribute[] => {
		const group = levels.get(signal.id) ?? levels.get(`${signal.kind}.${signal.id}`)
		return signal.attributes
			.map((id) => ({ id, level: group?.get(id) ?? "recommended" }))
			.sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || a.id.localeCompare(b.id))
	}

	// Requirement counts per specification area, for the governance block.
	const areaTotals = new Map<string, { count: number; binding: number; documents: Set<string> }>()
	for (const section of data.spec.latest.sections) {
		const area = section.path.split("/")[1]?.replace(/\.md$/, "") ?? ""
		const totals = areaTotals.get(area) ?? { count: 0, binding: 0, documents: new Set<string>() }
		totals.count += section.normative.length
		totals.binding += section.normative.filter((s) => LEVEL_WEIGHT(s.level) === 0).length
		if (section.normative.length > 0) totals.documents.add(section.path)
		areaTotals.set(area, totals)
	}

	const recentDiffs = data.semconv.diffs.slice(0, 6)

	return DOMAINS.map((def) => {
		const owns = (name: string) => BY_NAMESPACE.get(prefixOf(name))?.slug === def.slug

		const attributes = entries
			.filter(({ attribute }) => owns(attribute.namespace))
			.sort((a, b) => a.attribute.id.localeCompare(b.attribute.id))

		const counts = new Map<string, number>()
		for (const { attribute } of attributes) counts.set(attribute.namespace, (counts.get(attribute.namespace) ?? 0) + 1)

		const signals = latestWins([...data.signals, ...data.genai.latest.signals], (s) => `${s.kind}:${signalKey(s)}`).filter(
			(s) => owns(signalKey(s)),
		)
		const metrics = latestWins([...data.metrics, ...data.genai.latest.metrics], (m) => m.name)
			.filter((m) => owns(m.name))
			.sort((a, b) => a.name.localeCompare(b.name))

		const spans = signals.filter((s) => s.kind === "span").sort((a, b) => a.name.localeCompare(b.name))
		const events = signals.filter((s) => s.kind === "event").sort((a, b) => a.name.localeCompare(b.name))
		const domainEntities = signals.filter((s) => s.kind === "entity").sort((a, b) => a.name.localeCompare(b.name))

		const matcher = keywordMatcher(def.keywords ?? [])
		// A signal's own specification area binds it whether or not a sentence names it.
		const ownArea = def.wire ? `specification/${def.wire.area}/` : undefined
		const requirements: DomainRequirement[] = matcher
			? specSections
					.flatMap((section) => section.normative.map((statement) => ({ statement, section })))
					.filter(({ section }) => !TRANSPORT_DOCS.test(section.path))
					.filter(
						({ statement, section }) =>
							matcher.test(statement.text) || matcher.test(section.title) || (ownArea !== undefined && section.path.startsWith(ownArea)),
					)
					.sort(
						(a, b) =>
							// A section *about* the topic beats a passing mention of it, and a
							// requirement carrying a Markdown table beats nothing.
							Number(matcher.test(b.section.title)) - Number(matcher.test(a.section.title)) ||
							Number(b.section.status === "Stable") - Number(a.section.status === "Stable") ||
							LEVEL_WEIGHT(a.statement.level) - LEVEL_WEIGHT(b.statement.level) ||
							Number(a.statement.text.includes(" | ")) - Number(b.statement.text.includes(" | ")) ||
							a.section.id.localeCompare(b.section.id),
					)
			: []

		const present: [string, number][] = [
			["span", spans.length],
			["metric", metrics.length],
			["event", events.length],
			["entity", domainEntities.length],
		]
		const governed: { readonly area: string; readonly what: string; readonly protoFile?: string }[] = present
			.filter(([, n]) => n > 0)
			.map(([kind]) => ({ ...(AREA_FOR_SIGNAL[kind] as { area: string; what: string }), protoFile: PROTO_FOR_SIGNAL[kind] }))
		// The signal's own area comes first; its proto is the wire section, not a footnote.
		if (def.wire) governed.unshift({ area: def.wire.area, what: def.wire.what })
		const governance = governed
			.map((entry): Governance => {
				const totals = areaTotals.get(entry.area)
				return {
					...entry,
					count: totals?.count ?? 0,
					documents: totals?.documents.size ?? 0,
					binding: totals?.binding ?? 0,
				}
			})
			.filter((entry) => entry.count > 0)

		const changes = recentDiffs.flatMap((diff) =>
			diff.changes
				.filter((change) => change.severity !== "informational" && owns(change.id))
				.map((change) => ({ version: diff.to, change })),
		)

		return {
			def,
			slug: def.slug,
			title: def.title,
			blurb: def.blurb,
			namespaces: [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
			attributes,
			metrics,
			spans,
			events,
			entities: domainEntities,
			signalAttributes: new Map(signals.map((signal) => [signal.id, attributesFor(signal)])),
			deprecated: attributes.filter(({ attribute }) => attribute.deprecated).length,
			stable: attributes.filter(({ attribute }) => attribute.stability === "stable" && !attribute.deprecated).length,
			requirements,
			governance,
			changes,
			wire: def.wire ? wireData(def.wire, data) : undefined,
		}
	})
}

function wireData(def: DomainWire, data: Catalog): DomainWireData {
	const inPackage = (name: string) => def.packages.findIndex((pkg) => name.startsWith(`${pkg}.`))
	const messages = data.proto.latest.messages
		.filter((message) => inPackage(message.name) >= 0)
		.sort((a, b) => inPackage(a.name) - inPackage(b.name) || a.name.localeCompare(b.name))

	const published = new Map(data.proto.releases.map((release) => [release.version, release.publishedAt]))
	const history = data.proto.diffs.map((diff): WireRelease => {
		const changes = diff.changes.filter((change) => inPackage(change.id) >= 0)
		return {
			version: diff.to,
			publishedAt: published.get(diff.to) ?? "",
			// In a development package nothing is "breaking": the diff engine files a
			// removal or renumbering as notable, and an addition as informational.
			incompatible: changes.filter((change) => change.severity !== "informational"),
			compatible: changes.filter((change) => change.severity === "informational"),
		}
	})

	return { def, messages, history, lastIncompatible: history.find((release) => release.incompatible.length > 0) }
}
