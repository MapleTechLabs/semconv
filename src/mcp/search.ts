/**
 * Question-shaped retrieval over the site's search index, for the `search`
 * MCP tool. An agent asks in prose ("which attribute holds the HTTP status
 * code"), so unlike the browser search a row does not need every term: this
 * is a weighted sum over the terms that land, identifiers counting for more
 * than prose, deprecated rows held back unless the question is about them.
 */

export interface IndexEntry {
	type: string
	id: string
	text: string
	url: string
	meta: string
	renamedTo?: string
}

const STOP = new Set(
	"a an and are as at be by do does did for from has have how i in is it its of on or that the this to was what when where which who why with should can could would will still my our we you your there their about into use used using vs than then any some attribute attributes".split(
		" ",
	),
)

/** Words worth searching for. Identifiers are kept whole; prose is lowercased and stripped of stop words. */
export function tokens(question: string): string[] {
	const out = new Set<string>()
	for (const raw of question.toLowerCase().split(/[^a-z0-9._-]+/)) {
		const word = raw.replace(/^[._-]+|[._-]+$/g, "")
		if (word.length < 2 || STOP.has(word)) continue
		out.add(word)
	}
	return [...out]
}

const DEPRECATION_WORDS = /\b(deprecat|renam|still|replac|old|legacy|instead|success)/i

export const SIGNAL_TYPES: ReadonlySet<string> = new Set(["span", "event", "entity"])

const inType = (entry: IndexEntry, type: string | undefined): boolean =>
	!type || type === "all" || (type === "signal" ? SIGNAL_TYPES.has(entry.type) : entry.type === type)

export function retrieve(
	entries: readonly IndexEntry[],
	question: string,
	options: { type?: string; limit?: number } = {},
): (IndexEntry & { score: number })[] {
	const terms = tokens(question)
	if (terms.length === 0) return []
	const limit = options.limit ?? 20
	const wantsDeprecated = DEPRECATION_WORDS.test(question)
	const scored: (IndexEntry & { score: number })[] = []
	for (const entry of entries) {
		if (!inType(entry, options.type)) continue
		const id = entry.id.toLowerCase()
		const segments = id.split(/[.\-_\s/#:]+/)
		const text = entry.text.toLowerCase()
		const meta = entry.meta.toLowerCase()
		let score = 0
		let matched = 0
		for (const term of terms) {
			let hit = 0
			if (id === term) hit = 8
			else if (segments.includes(term)) hit = 4
			else if (segments.some((s) => s.startsWith(term))) hit = 3
			else if (id.includes(term)) hit = 2
			else if (text.includes(term)) hit = 1.5
			else if (meta.includes(term)) hit = 0.5
			if (hit > 0) matched++
			score += hit
		}
		if (matched === 0) continue
		// Two terms landing beats one landing twice.
		score *= 1 + 0.35 * (matched - 1)
		if (entry.type === "requirement") score *= 0.8
		if (meta.startsWith("deprecated") && !wantsDeprecated) score *= 0.6
		scored.push({ ...entry, score: Math.round(score * 100) / 100 })
	}
	scored.sort((a, b) => b.score - a.score || a.id.length - b.id.length)
	return scored.slice(0, limit)
}
