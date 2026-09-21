/**
 * The one search the site has, shared by the command palette, the /search
 * page and the 404 page so a query ranks the same wherever it is typed.
 *
 * Runs in the browser over `/api/search.json`, fetched once per page. The
 * index is 3,600-odd rows; a linear scan per keystroke is a few milliseconds.
 */

export interface Entry {
	/** `attribute`, `metric`, `span`, `event`, `entity`, `requirement`, `otlp`, `domain`. */
	readonly type: string
	readonly id: string
	readonly text: string
	readonly url: string
	readonly meta: string
	/** Deprecated attributes with a successor carry it, so a hit on the old name shows the new one. */
	readonly renamedTo?: string
}

export interface Indexed extends Entry {
	readonly lowerId: string
	readonly haystack: string
	/** `http.response.status_code` -> `["http", "response", "status", "code"]`. */
	readonly segments: readonly string[]
	readonly deprecated: boolean
}

export const TYPE_LABEL: Record<string, string> = {
	attribute: "attribute",
	metric: "metric",
	span: "span",
	event: "event",
	entity: "entity",
	requirement: "requirement",
	otlp: "otlp",
	domain: "domain",
	page: "page",
}

export const GROUP_LABEL: Record<string, string> = {
	page: "Pages",
	domain: "Domains",
	attribute: "Attributes",
	metric: "Metrics",
	span: "Spans",
	event: "Events",
	entity: "Entities",
	otlp: "OTLP",
	requirement: "Requirements",
}

/** Domains first: one of them is usually a better answer than any single row. */
export const TYPE_RANK: Record<string, number> = {
	page: -1,
	domain: 0,
	attribute: 1,
	metric: 2,
	span: 3,
	event: 4,
	entity: 5,
	otlp: 6,
	requirement: 7,
}

export const SIGNAL_TYPES: ReadonlySet<string> = new Set(["span", "event", "entity"])

/** `attr:http status` narrows to attributes; the prefix is the filter, not a term. */
export const PREFIXES: Record<string, string> = {
	attr: "attribute",
	attribute: "attribute",
	metric: "metric",
	span: "span",
	event: "event",
	entity: "entity",
	signal: "signal",
	spec: "requirement",
	req: "requirement",
	requirement: "requirement",
	otlp: "otlp",
	domain: "domain",
}

export const STATIC_PAGES: readonly Entry[] = [
	{ type: "page", id: "Changes", text: "Release history across all four sources.", url: "/", meta: "home" },
	{ type: "page", id: "Domains", text: "The conventions by topic.", url: "/domains", meta: "" },
	{ type: "page", id: "Registry", text: "Every attribute, grouped by namespace.", url: "/attributes", meta: "attributes" },
	{ type: "page", id: "Spec", text: "The specification's requirements.", url: "/spec", meta: "specification" },
	{ type: "page", id: "OTLP", text: "Wire definitions and protocol rules.", url: "/otlp", meta: "proto" },
	{ type: "page", id: "Compare", text: "Diff any two releases.", url: "/diff", meta: "diff versions" },
	{ type: "page", id: "About", text: "How this site reads the sources.", url: "/about", meta: "" },
]

const segmentsOf = (id: string) => id.toLowerCase().split(/[.\-_\s/#:]+/).filter(Boolean)

export const index = (entry: Entry): Indexed => ({
	...entry,
	lowerId: entry.id.toLowerCase(),
	haystack: `${entry.id} ${entry.text} ${entry.meta} ${entry.renamedTo ?? ""}`.toLowerCase(),
	segments: segmentsOf(entry.id),
	deprecated: entry.meta.startsWith("deprecated"),
})

let loading: Promise<Indexed[]> | undefined

/** Fetched once per page; every caller shares the same rows. */
export function loadIndex(): Promise<Indexed[]> {
	loading ??= fetch("/api/search.json")
		.then((response) => response.json() as Promise<{ entries: Entry[] }>)
		.then((payload) => [...STATIC_PAGES, ...payload.entries].map(index))
	return loading
}

export interface ParsedQuery {
	readonly terms: readonly string[]
	/** A type from `PREFIXES`, or null when the query carries no prefix. */
	readonly type: string | null
	readonly raw: string
}

export function parseQuery(raw: string): ParsedQuery {
	let type: string | null = null
	let rest = raw.trim().toLowerCase()
	const prefixed = /^([a-z]+):\s*/.exec(rest)
	if (prefixed && PREFIXES[prefixed[1] as string]) {
		type = PREFIXES[prefixed[1] as string] as string
		rest = rest.slice(prefixed[0].length)
	}
	return { terms: rest.split(/\s+/).filter(Boolean), type, raw: rest }
}

const isSubsequence = (needle: string, hay: string): boolean => {
	let i = 0
	for (const ch of hay) if (ch === needle[i] && ++i === needle.length) return true
	return needle.length === 0
}

/**
 * Lower is better; null is no match. Every term has to land somewhere.
 * 0 exact id · 1 id prefix · 2 a segment prefix (`status` in
 * `http.response.status_code`) · 3 id substring · 4 prose · 5 metadata ·
 * 6 fuzzy, for a term of four or more letters typed out of order.
 */
export function score(entry: Indexed, terms: readonly string[]): number | null {
	let worst = 0
	for (const term of terms) {
		let rank: number | null = null
		if (entry.lowerId === term) rank = 0
		else if (entry.lowerId.startsWith(term)) rank = 1
		else if (entry.segments.some((s) => s.startsWith(term))) rank = 2
		else if (entry.lowerId.includes(term)) rank = 3
		else if (entry.text.toLowerCase().includes(term)) rank = 4
		else if (entry.haystack.includes(term)) rank = 5
		else if (term.length >= 4 && isSubsequence(term, entry.lowerId)) rank = 6
		if (rank === null) return null
		worst = Math.max(worst, rank)
	}
	return worst
}

export const inType = (entry: Entry, type: string | null): boolean =>
	type === null || type === "all" || (type === "signal" ? SIGNAL_TYPES.has(entry.type) : entry.type === type)

export interface SearchResult {
	readonly hits: readonly Indexed[]
	/** Matches before the type filter and the limit. */
	readonly total: number
	readonly perType: Readonly<Record<string, number>>
	readonly query: ParsedQuery
}

export function search(
	entries: readonly Indexed[],
	raw: string,
	options: { type?: string | null; limit?: number } = {},
): SearchResult {
	const query = parseQuery(raw)
	const type = query.type ?? options.type ?? null
	const limit = options.limit ?? 80
	const perType: Record<string, number> = {}
	if (query.terms.length === 0) return { hits: [], total: 0, perType, query }

	const scored: { entry: Indexed; rank: number }[] = []
	for (const entry of entries) {
		const rank = score(entry, query.terms)
		if (rank === null) continue
		perType[entry.type] = (perType[entry.type] ?? 0) + 1
		if (!inType(entry, type)) continue
		scored.push({ entry, rank })
	}
	scored.sort(
		(a, b) =>
			a.rank - b.rank ||
			Number(a.entry.deprecated) - Number(b.entry.deprecated) ||
			(TYPE_RANK[a.entry.type] ?? 9) - (TYPE_RANK[b.entry.type] ?? 9) ||
			a.entry.id.length - b.entry.id.length ||
			a.entry.id.localeCompare(b.entry.id),
	)
	return { hits: scored.slice(0, limit).map((s) => s.entry), total: scored.length, perType, query }
}

/**
 * Three words, or a question mark, or an interrogative: something the index
 * cannot answer by substring and the assistant can.
 */
export function looksLikeQuestion(raw: string): boolean {
	const q = raw.trim()
	if (q.length < 8) return false
	if (q.endsWith("?")) return true
	if (/^(what|which|how|is|are|does|do|did|why|when|where|should|can|has|was|were)\b/i.test(q)) return true
	return q.split(/\s+/).length >= 4 && !/^[a-z]+:/.test(q)
}

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** Wraps each term in `<mark>`; the input is escaped first, so it is safe as HTML. */
export function highlight(text: string, terms: readonly string[]): string {
	const safe = escapeHtml(text)
	const words = terms.filter((t) => t.length >= 2).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	if (words.length === 0) return safe
	return safe.replace(new RegExp(`(${words.join("|")})`, "gi"), "<mark>$1</mark>")
}

const RECENT_KEY = "semconv.recent"

export function recentQueries(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_KEY)
		return raw ? (JSON.parse(raw) as string[]).slice(0, 6) : []
	} catch {
		return []
	}
}

export function rememberQuery(query: string): void {
	const q = query.trim()
	if (q.length < 2) return
	try {
		const next = [q, ...recentQueries().filter((x) => x !== q)].slice(0, 6)
		localStorage.setItem(RECENT_KEY, JSON.stringify(next))
	} catch {
		// Private mode or a full quota: recents are a convenience, not state.
	}
}
