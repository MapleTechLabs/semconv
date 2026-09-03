import { type Change, type EntityKind, type Severity, type SourceDiff, sortChanges, tally, truncate } from "./change.ts"
import type { Attribute, Deprecation, MetricDef, SemconvSnapshot, SignalDef, Stability } from "./types.ts"

export type { Change, ChangeKind, EntityKind, Severity } from "./change.ts"

export interface SemconvDiff extends SourceDiff {
	readonly source: "semconv"
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

/**
 * `alpha` and `experimental` are older spellings of the same tier as
 * `development` -- the v1.31.0 model relabelled the whole registry in one go.
 * Ranking them equal is what keeps that release from reading as 700 promotions.
 */
const STABILITY_RANK: Record<string, number> = {
	alpha: 1,
	experimental: 1,
	development: 1,
	release_candidate: 2,
	stable: 3,
	deprecated: 0,
}

const depKey = (d: Deprecation | undefined) => (d ? `${d.reason}${d.renamedTo ? `->${d.renamedTo}` : ""}` : "")

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
			const rankBefore = STABILITY_RANK[b.stability] ?? 1
			const rankAfter = STABILITY_RANK[a.stability] ?? 1
			const relabelled = rankAfter === rankBefore
			const promoted = rankAfter > rankBefore
			changes.push({
				kind: "stability-changed",
				severity: relabelled ? "informational" : promoted ? "notable" : bySt(b.stability, "breaking", "notable"),
				entity,
				id,
				stability: a.stability,
				detail: relabelled
					? `Stability label respelled from ${b.stability} to ${a.stability}.`
					: promoted
						? `Promoted to ${a.stability}.`
						: `Stability lowered to ${a.stability}.`,
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

	sortChanges(changes)
	return { source: "semconv", from: before.version, to: after.version, changes, counts: tally(changes) }
}

export type { Attribute, MetricDef, SignalDef }
