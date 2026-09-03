import type { Catalog } from "./catalog.ts"
import type { Change } from "./change.ts"
import type { Attribute, MetricDef, NormativeStatement, SignalDef, SpecSection } from "./types.ts"

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
}

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
		blurb: "Model calls, agents, tools and MCP. Split into its own repository in v1.44.0 and still unreleased.",
		namespaces: ["gen_ai", "openai", "mcp"],
		aliases: ["anthropic"],
		keywords: ["GenAI", "LLM"],
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
			"pprof",
			"profile",
		],
		aliases: ["kestrel", "cli"],
		keywords: ["profile", "process"],
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

		const signals = [...data.signals, ...data.genai.latest.signals].filter((s) => owns(s.id.replace(/^(span|event|entity)\./, "")))
		const metrics = [...data.metrics, ...data.genai.latest.metrics]
			.filter((m) => owns(m.name))
			.sort((a, b) => a.name.localeCompare(b.name))

		const spans = signals.filter((s) => s.kind === "span").sort((a, b) => a.name.localeCompare(b.name))
		const events = signals.filter((s) => s.kind === "event").sort((a, b) => a.name.localeCompare(b.name))
		const domainEntities = signals.filter((s) => s.kind === "entity").sort((a, b) => a.name.localeCompare(b.name))

		const matcher = keywordMatcher(def.keywords ?? [])
		const requirements: DomainRequirement[] = matcher
			? specSections
					.flatMap((section) => section.normative.map((statement) => ({ statement, section })))
					.filter(({ section }) => !TRANSPORT_DOCS.test(section.path))
					.filter(({ statement, section }) => matcher.test(statement.text) || matcher.test(section.title))
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
		const governance = present
			.filter(([, n]) => n > 0)
			.map(([kind]) => {
				const mapping = AREA_FOR_SIGNAL[kind] as { area: string; what: string }
				const totals = areaTotals.get(mapping.area)
				const governanceEntry: Governance = {
					area: mapping.area,
					what: mapping.what,
					count: totals?.count ?? 0,
					documents: totals?.documents.size ?? 0,
					binding: totals?.binding ?? 0,
					protoFile: PROTO_FOR_SIGNAL[kind],
				}
				return governanceEntry
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
		}
	})
}
