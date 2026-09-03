import type { Attribute, Deprecation, MetricDef, SemconvSnapshot, SignalDef, Stability } from "./types.ts"

export type ChangeKind =
	| "added"
	| "removed"
	| "renamed"
	| "deprecated"
	| "undeprecated"
	| "stability-changed"
	| "type-changed"
	| "unit-changed"
	| "instrument-changed"
	| "enum-members-changed"
	| "brief-changed"
	| "note-changed"
	| "examples-changed"

/**
 * Every release touches a hundred things and breaks two. The severity split is
 * the whole reason this is readable: `breaking` means a backend or an
 * instrumentation author has work to do, `notable` means read it, and
 * `informational` is wording.
 */
export type Severity = "breaking" | "notable" | "informational"

export type EntityKind = "attribute" | "metric" | "signal"

export interface Change {
	readonly kind: ChangeKind
	readonly severity: Severity
	readonly entity: EntityKind
	readonly id: string
	/** Stability of the entity in the newer snapshot (or the older one, if removed). */
	readonly stability: Stability
	readonly detail: string
	readonly from?: string
	readonly to?: string
	/** For renames: the successor id, so consumers do not have to parse `detail`. */
	readonly renamedTo?: string
}

export interface SemconvDiff {
	readonly source: "semconv"
	readonly from: string
	readonly to: string
	readonly changes: readonly Change[]
	readonly counts: Readonly<Record<Severity, number>>
}

const isStable = (s: Stability) => s === "stable" || s === "release_candidate"

/**
 * Anything that removes, renames, or walks back a *stable* definition is
 * breaking - that is the promise the spec makes about stable, so breaking it is
 * exactly the event worth waking someone for. The same change on a
 * `development` definition is expected churn.
 */
const bySt = (stability: Stability, whenStable: Severity, otherwise: Severity): Severity =>
	isStable(stability) ? whenStable : otherwise

const STABILITY_RANK: Record<string, number> = {
	alpha: 0,
	experimental: 0,
	development: 1,
	release_candidate: 2,
	stable: 3,
	deprecated: -1,
}

const depKey = (d: Deprecation | undefined) => (d ? `${d.reason}${d.renamedTo ? `->${d.renamedTo}` : ""}` : "")

const truncate = (s: string, n = 160) => (s.length <= n ? s : `${s.slice(0, n - 1)}...`)

interface Common {
	readonly id: string
	readonly stability: Stability
	readonly brief: string
	readonly note?: string
	readonly deprecated?: Deprecation
}

/** The lifecycle changes every entity kind shares: added, removed, deprecated, stability. */
function diffCommon(entity: EntityKind, before: Map<string, Common>, after: Map<string, Common>): Change[] {
	const changes: Change[] = []

	for (const [id, b] of before) {
		if (after.has(id)) continue
		// A removal from the registry, as opposed to a deprecation-in-place. Rare,
		// and always worth surfacing - a deprecated-but-present attribute still
		// resolves for consumers, a removed one does not.
		changes.push({
			kind: "removed",
			severity: bySt(b.stability, "breaking", "notable"),
			entity,
			id,
			stability: b.stability,
			detail: `Removed from the registry (was ${b.stability}).`,
		})
	}

	for (const [id, a] of after) {
		const b = before.get(id)

		if (!b) {
			changes.push({
				kind: "added",
				severity: "informational",
				entity,
				id,
				stability: a.stability,
				detail: truncate(a.brief) || `Added as ${a.stability}.`,
			})
			continue
		}

		if (depKey(a.deprecated) !== depKey(b.deprecated)) {
			if (a.deprecated && a.deprecated.reason === "renamed" && a.deprecated.renamedTo) {
				changes.push({
					kind: "renamed",
					severity: bySt(b.stability, "breaking", "notable"),
					entity,
					id,
					stability: a.stability,
					detail: `Renamed to \`${a.deprecated.renamedTo}\`.`,
					from: id,
					to: a.deprecated.renamedTo,
					renamedTo: a.deprecated.renamedTo,
				})
			} else if (a.deprecated) {
				changes.push({
					kind: "deprecated",
					severity: bySt(b.stability, "breaking", "notable"),
					entity,
					id,
					stability: a.stability,
					detail: a.deprecated.note ? truncate(a.deprecated.note) : `Deprecated (${a.deprecated.reason}).`,
				})
			} else {
				changes.push({
					kind: "undeprecated",
					severity: "notable",
					entity,
					id,
					stability: a.stability,
					detail: "No longer marked deprecated.",
				})
			}
		}

		if (a.stability !== b.stability) {
			const promoted = (STABILITY_RANK[a.stability] ?? 0) > (STABILITY_RANK[b.stability] ?? 0)
			changes.push({
				kind: "stability-changed",
				severity: promoted ? "notable" : bySt(b.stability, "breaking", "notable"),
				entity,
				id,
				stability: a.stability,
				detail: promoted ? `Promoted to ${a.stability}.` : `Stability lowered to ${a.stability}.`,
				from: b.stability,
				to: a.stability,
			})
		}

		if (a.note !== b.note) {
			changes.push({
				kind: "note-changed",
				severity: "informational",
				entity,
				id,
				stability: a.stability,
				detail: "Guidance note changed.",
			})
		} else if (a.brief !== b.brief) {
			changes.push({
				kind: "brief-changed",
				severity: "informational",
				entity,
				id,
				stability: a.stability,
				detail: truncate(a.brief),
			})
		}
	}

	return changes
}

const enumKey = (a: Attribute) =>
	(a.enumMembers ?? [])
		.map((m) => `${m.id}=${m.value}`)
		.sort()
		.join(",")

const SEVERITY_ORDER: Record<Severity, number> = { breaking: 0, notable: 1, informational: 2 }
const KIND_ORDER: ChangeKind[] = [
	"removed",
	"renamed",
	"deprecated",
	"type-changed",
	"unit-changed",
	"instrument-changed",
	"stability-changed",
	"enum-members-changed",
	"undeprecated",
	"added",
	"note-changed",
	"brief-changed",
	"examples-changed",
]

export function diffSemconv(before: SemconvSnapshot, after: SemconvSnapshot): SemconvDiff {
	const attrsBefore = new Map(before.attributes.map((a) => [a.id, a]))
	const attrsAfter = new Map(after.attributes.map((a) => [a.id, a]))

	const changes: Change[] = [
		...diffCommon("attribute", attrsBefore as unknown as Map<string, Common>, attrsAfter as unknown as Map<string, Common>),
		...diffCommon(
			"metric",
			new Map(before.metrics.map((m) => [m.name, { ...m, id: m.name }])),
			new Map(after.metrics.map((m) => [m.name, { ...m, id: m.name }])),
		),
		...diffCommon("signal", new Map(before.signals.map((s) => [s.id, s])), new Map(after.signals.map((s) => [s.id, s]))),
	]

	// Attribute-only shape changes. A type or enum change is a decoding change for
	// anyone who stored the old shape, so it ranks with the lifecycle events.
	for (const [id, a] of attrsAfter) {
		const b = attrsBefore.get(id)
		if (!b) continue
		if (a.type !== b.type) {
			changes.push({
				kind: "type-changed",
				severity: bySt(a.stability, "breaking", "notable"),
				entity: "attribute",
				id,
				stability: a.stability,
				detail: `Type changed from \`${b.type}\` to \`${a.type}\`.`,
				from: b.type,
				to: a.type,
			})
		}
		if (enumKey(a) !== enumKey(b)) {
			changes.push({
				kind: "enum-members-changed",
				severity: bySt(a.stability, "notable", "informational"),
				entity: "attribute",
				id,
				stability: a.stability,
				detail: `Enum members changed (${b.enumMembers?.length ?? 0} to ${a.enumMembers?.length ?? 0}).`,
			})
		}
		if (a.examples.join(" ") !== b.examples.join(" ")) {
			changes.push({
				kind: "examples-changed",
				severity: "informational",
				entity: "attribute",
				id,
				stability: a.stability,
				detail: "Examples changed.",
			})
		}
	}

	// Metric-only shape changes: unit and instrument are wire-visible.
	const metricsBefore = new Map(before.metrics.map((m) => [m.name, m]))
	for (const m of after.metrics) {
		const b = metricsBefore.get(m.name)
		if (!b) continue
		if (m.unit !== b.unit) {
			changes.push({
				kind: "unit-changed",
				severity: bySt(m.stability, "breaking", "notable"),
				entity: "metric",
				id: m.name,
				stability: m.stability,
				detail: `Unit changed from \`${b.unit}\` to \`${m.unit}\`.`,
				from: b.unit,
				to: m.unit,
			})
		}
		if (m.instrument !== b.instrument) {
			changes.push({
				kind: "instrument-changed",
				severity: bySt(m.stability, "breaking", "notable"),
				entity: "metric",
				id: m.name,
				stability: m.stability,
				detail: `Instrument changed from \`${b.instrument}\` to \`${m.instrument}\`.`,
				from: b.instrument,
				to: m.instrument,
			})
		}
	}

	changes.sort(
		(x, y) =>
			SEVERITY_ORDER[x.severity] - SEVERITY_ORDER[y.severity] ||
			KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind) ||
			x.id.localeCompare(y.id),
	)

	const counts = { breaking: 0, notable: 0, informational: 0 }
	for (const c of changes) counts[c.severity]++

	return { source: "semconv", from: before.version, to: after.version, changes, counts }
}

export type { Attribute, MetricDef, SignalDef }
