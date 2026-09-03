import { type Change, type Severity, type SourceDiff, sortChanges, tally, truncate } from "./change.ts"
import type { NormativeStatement, SpecSnapshot } from "./types.ts"

export interface SpecDiff extends SourceDiff {
	readonly source: "spec"
}

/**
 * Diffs specification prose by its requirements rather than its words.
 *
 * A plain text diff of the specification is unreadable: every release reflows
 * paragraphs, renumbers lists and rewrites examples. What an implementer needs
 * is narrower and answerable - which RFC 2119 requirements appeared, vanished,
 * or changed strength. Those are the sentences that bind an implementation, and
 * everything else is editing.
 */

/**
 * A document marked Stable has made a compatibility promise. Adding a MUST to
 * it can invalidate an implementation that was previously conformant, which is
 * the closest thing prose has to a breaking change.
 */
const isStableDoc = (status: string) => status === "Stable" || status === "Release Candidate"

const STRENGTH: Record<string, number> = {
	MAY: 1,
	OPTIONAL: 1,
	RECOMMENDED: 2,
	"NOT RECOMMENDED": 2,
	SHOULD: 2,
	"SHOULD NOT": 2,
	REQUIRED: 3,
	SHALL: 3,
	"SHALL NOT": 3,
	MUST: 3,
	"MUST NOT": 3,
}

const isBinding = (level: string) => (STRENGTH[level] ?? 0) === 3

const tokens = (text: string) =>
	new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s]/g, " ")
			.split(/\s+/)
			.filter((word) => word.length > 3),
	)

/**
 * Overlap between two sentences, as a fraction of the smaller one. Used only to
 * pair a removal with an addition so a reflowed sentence reads as "reworded"
 * instead of as one requirement disappearing and an unrelated one arriving.
 */
function similarity(a: string, b: string): number {
	const left = tokens(a)
	const right = tokens(b)
	if (left.size === 0 || right.size === 0) return 0
	let shared = 0
	for (const word of left) if (right.has(word)) shared++
	return shared / Math.min(left.size, right.size)
}

const REWORD_THRESHOLD = 0.6

export function diffSpec(before: SpecSnapshot, after: SpecSnapshot): SpecDiff {
	const changes: Change[] = []

	// --- documents -------------------------------------------------------
	const docsBefore = new Map(before.documents.map((d) => [d.path, d]))
	const docsAfter = new Map(after.documents.map((d) => [d.path, d]))

	for (const [path, doc] of docsBefore) {
		if (docsAfter.has(path)) continue
		changes.push({
			kind: "removed",
			severity: isStableDoc(doc.status) ? "breaking" : "notable",
			entity: "document",
			id: path,
			stability: doc.status,
			detail: `Document removed (was ${doc.status}).`,
		})
	}

	for (const [path, doc] of docsAfter) {
		const previous = docsBefore.get(path)
		if (!previous) {
			changes.push({
				kind: "added",
				severity: "informational",
				entity: "document",
				id: path,
				stability: doc.status,
				detail: `New document: ${doc.title} (${doc.status}).`,
				href: path,
			})
			continue
		}
		if (previous.status !== doc.status) {
			changes.push({
				kind: "stability-changed",
				severity: "notable",
				entity: "document",
				id: path,
				stability: doc.status,
				detail: `Status changed from ${previous.status} to ${doc.status}.`,
				from: previous.status,
				to: doc.status,
				href: path,
			})
		}
	}

	// --- sections --------------------------------------------------------
	const sectionsBefore = new Map(before.sections.map((s) => [s.id, s]))
	const sectionsAfter = new Map(after.sections.map((s) => [s.id, s]))

	for (const [id, section] of sectionsBefore) {
		// A section that vanished with its whole document is already reported
		// above; repeating it per heading would bury everything else.
		if (sectionsAfter.has(id) || !docsAfter.has(section.path)) continue
		changes.push({
			kind: "removed",
			severity: isStableDoc(section.status) ? "notable" : "informational",
			entity: "section",
			id,
			stability: section.status,
			detail: `Section "${section.title}" removed.`,
		})
	}

	for (const [id, section] of sectionsAfter) {
		const previous = sectionsBefore.get(id)
		if (!previous) {
			if (docsBefore.has(section.path)) {
				changes.push({
					kind: "added",
					severity: "informational",
					entity: "section",
					id,
					stability: section.status,
					detail: `New section "${section.title}".`,
					href: id,
				})
			}
			continue
		}
		// Length is a crude proxy, but a section that grew or shrank by a third
		// was rewritten, and that is worth a link even when no MUST moved.
		const ratio = previous.length === 0 ? 1 : Math.abs(section.length - previous.length) / previous.length
		if (ratio > 0.33 && Math.abs(section.length - previous.length) > 200) {
			changes.push({
				kind: "section-rewritten",
				severity: "informational",
				entity: "section",
				id,
				stability: section.status,
				detail: `"${section.title}" substantially rewritten (${previous.length} to ${section.length} characters).`,
				href: id,
			})
		}
	}

	// --- requirements ----------------------------------------------------
	const before2119 = new Map<string, NormativeStatement>()
	const after2119 = new Map<string, NormativeStatement>()
	for (const section of before.sections) for (const n of section.normative) before2119.set(n.id, n)
	for (const section of after.sections) for (const n of section.normative) after2119.set(n.id, n)

	const removed = [...before2119.values()].filter((n) => !after2119.has(n.id))
	const added = [...after2119.values()].filter((n) => !before2119.has(n.id))

	// Pair removals with additions in the same section before reporting either,
	// so a reflowed paragraph does not read as a requirement being dropped.
	const statusOf = (id: string) => sectionsAfter.get(id)?.status ?? sectionsBefore.get(id)?.status ?? "Unspecified"
	const unmatchedAdded = new Set(added)
	const unmatchedRemoved: NormativeStatement[] = []

	/**
	 * Requirements also *move*: v1.60.0 split `resource/sdk.md#merge` into two
	 * sections and carried its MUSTs across verbatim. Matching only within a
	 * section would report each of those twice - once as a stable requirement
	 * being dropped, once as a new one appearing - which is the loudest possible
	 * way to say nothing happened. So relocations are matched in a second pass,
	 * at a much higher similarity bar since there is no section to corroborate.
	 */
	const MOVE_THRESHOLD = 0.85

	for (const gone of removed) {
		let best: NormativeStatement | undefined
		let bestScore = REWORD_THRESHOLD
		for (const candidate of unmatchedAdded) {
			if (candidate.section !== gone.section) continue
			const score = similarity(gone.text, candidate.text)
			if (score > bestScore) {
				best = candidate
				bestScore = score
			}
		}

		if (!best) {
			unmatchedRemoved.push(gone)
			continue
		}

		unmatchedAdded.delete(best)
		const status = statusOf(best.section)
		if (best.level !== gone.level) {
			const strengthened = (STRENGTH[best.level] ?? 0) > (STRENGTH[gone.level] ?? 0)
			changes.push({
				kind: "requirement-level-changed",
				severity: isStableDoc(status) ? "breaking" : "notable",
				entity: "requirement",
				id: best.section,
				stability: status,
				detail: `${gone.level} ${strengthened ? "strengthened" : "relaxed"} to ${best.level}: ${truncate(best.text, 200)}`,
				from: gone.level,
				to: best.level,
				href: best.section,
			})
		} else {
			changes.push({
				kind: "requirement-reworded",
				severity: "informational",
				entity: "requirement",
				id: best.section,
				stability: status,
				detail: `${best.level} reworded: ${truncate(best.text, 200)}`,
				href: best.section,
			})
		}
	}

	const documentOf = (sectionId: string) => sectionId.split("#")[0] as string

	for (const gone of unmatchedRemoved) {
		let best: NormativeStatement | undefined
		let bestScore = MOVE_THRESHOLD
		for (const candidate of unmatchedAdded) {
			// Requirements move between sections of a document, not between
			// documents; allowing the latter would pair unrelated boilerplate.
			if (documentOf(candidate.section) !== documentOf(gone.section)) continue
			const score = similarity(gone.text, candidate.text)
			if (score > bestScore) {
				best = candidate
				bestScore = score
			}
		}

		if (best) {
			unmatchedAdded.delete(best)
			changes.push({
				kind: "requirement-moved",
				severity: "informational",
				entity: "requirement",
				id: best.section,
				stability: statusOf(best.section),
				detail: `${best.level} moved here from "${gone.section.split("#")[1]}": ${truncate(best.text, 200)}`,
				from: gone.section,
				to: best.section,
				href: best.section,
			})
			continue
		}

		{
			const status = statusOf(gone.section)
			// A binding requirement disappearing from a stable document is the
			// single most consequential thing that can happen in prose.
			changes.push({
				kind: "requirement-removed",
				severity: isBinding(gone.level) ? (isStableDoc(status) ? "breaking" : "notable") : "informational",
				entity: "requirement",
				id: gone.section,
				stability: status,
				detail: `${gone.level} removed: ${truncate(gone.text, 220)}`,
				href: gone.section,
			})
		}
	}

	for (const fresh of unmatchedAdded) {
		const status = statusOf(fresh.section)
		const severity: Severity = isBinding(fresh.level)
			? isStableDoc(status)
				? "breaking"
				: "notable"
			: isStableDoc(status)
				? "notable"
				: "informational"
		changes.push({
			kind: "requirement-added",
			severity,
			entity: "requirement",
			id: fresh.section,
			stability: status,
			detail: `${fresh.level} added: ${truncate(fresh.text, 220)}`,
			href: fresh.section,
		})
	}

	sortChanges(changes)
	return { source: "spec", from: before.version, to: after.version, changes, counts: tally(changes) }
}
