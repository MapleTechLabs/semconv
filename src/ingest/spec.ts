import { createHash } from "node:crypto"
import { readdir, readFile } from "node:fs/promises"
import type { NormativeLevel, NormativeStatement, SpecDocument, SpecSection, SpecSnapshot } from "../model/types.ts"

/**
 * Normalizes the OpenTelemetry specification repository into a snapshot.
 *
 * The specification is prose, so unlike the conventions there is no structured
 * model to read. What makes it diffable anyway is RFC 2119: the sentences that
 * bind an implementation are exactly the ones containing MUST, SHOULD or MAY in
 * capitals. Those are extracted per section and identified by a hash of their
 * normalized text, which is what separates "a new requirement appeared" from "a
 * paragraph was reflowed" -- the difference between a useful tracker and a diff
 * of whitespace.
 */

/**
 * Longest first, so `MUST NOT` is matched before `MUST` and a prohibition is
 * never recorded as a requirement.
 */
const LEVELS: readonly NormativeLevel[] = [
	"MUST NOT",
	"SHALL NOT",
	"SHOULD NOT",
	"NOT RECOMMENDED",
	"MUST",
	"SHALL",
	"SHOULD",
	"REQUIRED",
	"RECOMMENDED",
	"OPTIONAL",
	"MAY",
]

const LEVEL_PATTERN = new RegExp(`\\b(${LEVELS.map((l) => l.replace(" ", "\\s+")).join("|")})\\b`)

const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12)

/**
 * GitHub's heading slug algorithm, which is what the spec's own cross-document
 * links assume. Getting this wrong would break every deep link on the site.
 */
const slugify = (title: string) =>
	title
		.toLowerCase()
		.replace(/`/g, "")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/\s+/g, "-")

const stripNoise = (markdown: string) =>
	markdown
		// Hugo front matter, written as an HTML comment.
		.replace(/<!---[\s\S]*?--->/g, "")
		// The generated table of contents, which changes whenever any heading does
		// and would otherwise dominate every diff.
		.replace(/<details>[\s\S]*?<\/details>/g, "")
		.replace(/<!--\s*START doctoc[\s\S]*?END doctoc\s*-->/g, "")
		// Fenced code: examples are not requirements, and their contents would
		// otherwise be sentence-split into nonsense.
		.replace(/```[\s\S]*?```/g, "")
		.replace(/<!--[\s\S]*?-->/g, "")

const normalizeText = (text: string) =>
	text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1")
		.replace(/\s+/g, " ")
		.trim()

/**
 * Splits a section body into candidate sentences. List items are treated as
 * whole statements rather than being merged with their neighbours, because the
 * spec routinely expresses a requirement as a bullet.
 */
function sentences(body: string): string[] {
	const blocks = body
		.split(/\n\s*\n|\n(?=\s*[-*+]\s)|\n(?=\s*\d+\.\s)/)
		.map((block) => normalizeText(block.replace(/^\s*(?:[-*+]|\d+\.)\s*/, "")))
		.filter((block) => block.length > 0)

	return blocks.flatMap((block) =>
		block
			// A sentence ends at ".!?" followed by whitespace and something that
			// starts a new one. The negative lookbehind keeps the abbreviations the
			// spec leans on -- "e.g. (see below)" was otherwise split mid-clause.
			.split(/(?<!\b(?:e\.g|i\.e|etc|vs|cf|resp|approx|Fig|no|No)\.)(?<=[.!?])\s+(?=[A-Z`[(])/)
			.map((sentence) => sentence.trim())
			.filter((sentence) => sentence.length > 0),
	)
}

function normativeStatements(body: string, sectionId: string): NormativeStatement[] {
	const seen = new Set<string>()
	const out: NormativeStatement[] = []

	for (const sentence of sentences(body)) {
		if (!LEVEL_PATTERN.test(sentence)) continue
		const level = LEVELS.find((candidate) => new RegExp(`\\b${candidate.replace(" ", "\\s+")}\\b`).test(sentence))
		if (!level) continue

		// Very long "sentences" are almost always a table row or a mis-split
		// paragraph; keeping them produces statements nobody can read.
		const text = sentence.length > 600 ? `${sentence.slice(0, 599)}...` : sentence
		const id = hash(`${sectionId}|${text.toLowerCase()}`)
		if (seen.has(id)) continue
		seen.add(id)
		out.push({ id, level, text, section: sectionId })
	}

	return out
}

const documentStatus = (markdown: string): string => {
	const match = markdown.match(/\*\*Status\*\*:\s*\[?([A-Za-z ]+?)\]?[(,\n]/)
	return match?.[1]?.trim() ?? "Unspecified"
}

async function markdownFiles(root: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(`${root}/${prefix}`, { withFileTypes: true })
	const out: string[] = []
	for (const entry of entries) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) out.push(...(await markdownFiles(root, path)))
		else if (entry.name.endsWith(".md")) out.push(path)
	}
	return out
}

/**
 * Walks a directory of specification Markdown and returns its sections.
 *
 * Shared with the OTLP ingest, because the OTLP protocol specification is not
 * in the specification repository at all -- `specification/protocol/otlp.md` is
 * a stub that redirects to the website, and the real 800-line document lives in
 * `docs/specification.md` of the proto repository. Anything checking a
 * collector or an OTLP server against "the spec" needs that file, so both
 * sources parse prose the same way.
 */
export async function normalizeMarkdownTree(
	root: string,
	subdirectory: string,
): Promise<{ documents: SpecDocument[]; sections: SpecSection[] }> {
	const specRoot = `${root}/${subdirectory}`
	const files = (await markdownFiles(specRoot)).sort()

	const documents: SpecDocument[] = []
	const sections: SpecSection[] = []

	for (const file of files) {
		const path = `${subdirectory}/${file}`
		const raw = await readFile(`${specRoot}/${file}`, "utf8")
		const body = stripNoise(raw)
		const status = documentStatus(raw)

		const lines = body.split("\n")
		let title = file
		let current: { anchor: string; title: string; depth: number; buffer: string[] } | undefined
		const anchorCounts = new Map<string, number>()

		const flush = () => {
			if (!current) return
			const id = `${path}#${current.anchor}`
			const text = current.buffer.join("\n").trim()
			sections.push({
				id,
				path,
				anchor: current.anchor,
				title: current.title,
				depth: current.depth,
				status,
				length: text.length,
				normative: normativeStatements(text, id),
			})
		}

		for (const line of lines) {
			const heading = line.match(/^(#{1,6})\s+(.*)$/)
			if (!heading) {
				current?.buffer.push(line)
				continue
			}
			flush()

			const depth = (heading[1] as string).length
			const headingTitle = normalizeText(heading[2] as string)
			if (depth === 1 && title === file) title = headingTitle

			// GitHub disambiguates repeated headings with a numeric suffix; the
			// spec has plenty ("Operations" under several parents).
			const base = slugify(headingTitle)
			const seen = anchorCounts.get(base) ?? 0
			anchorCounts.set(base, seen + 1)
			const anchor = seen === 0 ? base : `${base}-${seen}`

			current = { anchor, title: headingTitle, depth, buffer: [] }
		}
		flush()

		documents.push({ path, title, status })
	}

	return {
		documents: documents.sort((a, b) => a.path.localeCompare(b.path)),
		sections: sections.sort((a, b) => a.id.localeCompare(b.id)),
	}
}

export async function normalizeSpec(
	root: string,
	meta: { tag: string; version: string; publishedAt: string },
): Promise<SpecSnapshot> {
	// Only `specification/` is read. `oteps/`, `development/` and
	// `supplementary-guidelines/` are proposals and commentary; treating their
	// MUSTs as binding would misrepresent them.
	const { documents, sections } = await normalizeMarkdownTree(root, "specification")
	return { source: "spec", version: meta.version, tag: meta.tag, publishedAt: meta.publishedAt, documents, sections }
}
