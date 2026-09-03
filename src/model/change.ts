import type { Stability } from "./types.ts"

/**
 * The vocabulary every source's diff speaks.
 *
 * Semantic conventions, specification prose and the OTLP wire definitions have
 * nothing in common structurally, but the question a reader brings to all three
 * is the same: what changed, and does it break me. Sharing one `Change` shape
 * means the release feed, the RSS entries and the MCP tools each need one
 * renderer rather than three.
 */

export type ChangeKind =
	// Shared lifecycle
	| "added"
	| "removed"
	| "renamed"
	| "deprecated"
	| "undeprecated"
	| "stability-changed"
	// Semantic conventions
	| "type-changed"
	| "unit-changed"
	| "instrument-changed"
	| "enum-members-changed"
	| "brief-changed"
	| "note-changed"
	| "examples-changed"
	// Specification prose
	| "requirement-added"
	| "requirement-removed"
	| "requirement-reworded"
	| "requirement-moved"
	| "requirement-level-changed"
	| "section-rewritten"
	// OTLP wire definitions
	| "field-added"
	| "field-removed"
	| "field-renamed"
	| "field-type-changed"
	| "field-number-changed"
	| "field-label-changed"
	| "value-added"
	| "value-removed"

/**
 * Every release touches a hundred things and breaks two. The severity split is
 * the whole reason this is readable: `breaking` means a backend or an
 * instrumentation author has work to do, `notable` means read it, and
 * `informational` is wording.
 */
export type Severity = "breaking" | "notable" | "informational"

export type EntityKind =
	| "attribute"
	| "metric"
	| "signal"
	| "document"
	| "section"
	| "requirement"
	| "message"
	| "field"
	| "enum value"

export interface Change {
	readonly kind: ChangeKind
	readonly severity: Severity
	readonly entity: EntityKind
	/** The thing that changed: an attribute id, a section anchor, a field path. */
	readonly id: string
	/** Stability of the entity where the source has a notion of it. */
	readonly stability: Stability | string
	readonly detail: string
	readonly from?: string
	readonly to?: string
	/** For renames: the successor, so consumers do not have to parse `detail`. */
	readonly renamedTo?: string
	/** Where to read more: an upstream path plus anchor, when there is one. */
	readonly href?: string
}

export interface SourceDiff {
	readonly source: "semconv" | "spec" | "proto"
	readonly from: string
	readonly to: string
	readonly changes: readonly Change[]
	readonly counts: Readonly<Record<Severity, number>>
}

export const SEVERITY_ORDER: Record<Severity, number> = { breaking: 0, notable: 1, informational: 2 }

export const KIND_ORDER: ChangeKind[] = [
	"removed",
	"renamed",
	"deprecated",
	"field-removed",
	"field-number-changed",
	"field-type-changed",
	"field-renamed",
	"field-label-changed",
	"value-removed",
	"requirement-removed",
	"requirement-level-changed",
	"type-changed",
	"unit-changed",
	"instrument-changed",
	"stability-changed",
	"requirement-added",
	"requirement-reworded",
	"requirement-moved",
	"enum-members-changed",
	"undeprecated",
	"added",
	"field-added",
	"value-added",
	"section-rewritten",
	"note-changed",
	"brief-changed",
	"examples-changed",
]

/** Sorts most consequential first, then by kind, then alphabetically. */
export function sortChanges(changes: Change[]): Change[] {
	return changes.sort(
		(x, y) =>
			SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] ||
			KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) ||
			x.id.localeCompare(y.id),
	)
}

export function tally(changes: readonly Change[]): Record<Severity, number> {
	const counts: Record<Severity, number> = { breaking: 0, notable: 0, informational: 0 }
	for (const change of changes) counts[change.severity]++
	return counts
}

export const truncate = (s: string, n = 160) => (s.length <= n ? s : `${s.slice(0, n - 1)}...`)
