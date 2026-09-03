import { listSnapshots, readIndex, readSemconv } from "../ingest/store.ts"
import type { Attribute, MetricDef, ReleaseRecord, SemconvSnapshot, SignalDef } from "./types.ts"
import { diffSemconv, type Change, type SemconvDiff } from "./diff.ts"

/**
 * Everything the site renders, assembled once from the committed snapshots.
 *
 * This is deliberately eager and in-memory: sixteen releases of semconv is a
 * few megabytes decompressed, and having the whole history resident is what
 * makes per-attribute lifecycles cheap to compute. It is built once per `astro
 * build` and shared by every page.
 */

export interface LifecycleEvent {
	readonly version: string
	readonly publishedAt: string
	readonly kind: Change["kind"] | "first-seen"
	readonly detail: string
	readonly severity?: Change["severity"]
}

export interface Catalog {
	/** Newest first. */
	readonly versions: readonly string[]
	readonly latest: SemconvSnapshot
	/** Consecutive-release diffs, newest first. */
	readonly diffs: readonly SemconvDiff[]
	readonly releases: readonly ReleaseRecord[]
	readonly releaseByTag: ReadonlyMap<string, ReleaseRecord>
	/** Attribute id -> its history, oldest first. */
	readonly lifecycle: ReadonlyMap<string, readonly LifecycleEvent[]>
	readonly attributes: readonly Attribute[]
	readonly metrics: readonly MetricDef[]
	readonly signals: readonly SignalDef[]
	/** Deprecated attributes whose successor is known, for the rename lookup. */
	readonly renames: ReadonlyMap<string, string>
	readonly namespaces: readonly { readonly name: string; readonly count: number }[]
	snapshot(version: string): SemconvSnapshot
	diff(from: string, to: string): SemconvDiff
}

let cached: Promise<Catalog> | undefined

export function catalog(): Promise<Catalog> {
	cached ??= build()
	return cached
}

async function build(): Promise<Catalog> {
	const versions = await listSnapshots("semconv")
	if (versions.length === 0) throw new Error("no semconv snapshots in data/ - run `bun run ingest` first")

	const snapshots = new Map<string, SemconvSnapshot>()
	for (const version of versions) snapshots.set(version, await readSemconv(version))

	const oldestFirst = [...versions].reverse()
	const latest = snapshots.get(versions[0] as string) as SemconvSnapshot

	const index = await readIndex()
	const releases = index.releases.filter((r) => r.source === "semconv")
	const releaseByVersion = new Map(releases.map((r) => [r.version, r]))

	// Consecutive diffs, plus the lifecycle they imply.
	const diffs: SemconvDiff[] = []
	const lifecycle = new Map<string, LifecycleEvent[]>()

	const push = (id: string, event: LifecycleEvent) => {
		const events = lifecycle.get(id)
		if (events) events.push(event)
		else lifecycle.set(id, [event])
	}

	const first = snapshots.get(oldestFirst[0] as string) as SemconvSnapshot
	const firstPublished = releaseByVersion.get(first.version)?.publishedAt ?? first.publishedAt
	for (const a of first.attributes) {
		push(a.id, {
			version: first.version,
			publishedAt: firstPublished,
			kind: "first-seen",
			// The floor is a choice we made, not a fact about the spec, so the copy
			// has to be honest that the attribute may well predate it.
			detail: `Already present at v${first.version}, the oldest release tracked here (${a.stability}).`,
		})
	}

	for (let i = 1; i < oldestFirst.length; i++) {
		const before = snapshots.get(oldestFirst[i - 1] as string) as SemconvSnapshot
		const after = snapshots.get(oldestFirst[i] as string) as SemconvSnapshot
		const diff = diffSemconv(before, after)
		diffs.push(diff)

		const publishedAt = releaseByVersion.get(after.version)?.publishedAt ?? after.publishedAt
		for (const change of diff.changes) {
			if (change.kind === "note-changed" || change.kind === "brief-changed" || change.kind === "examples-changed") continue
			push(change.id, {
				version: after.version,
				publishedAt,
				kind: change.kind === "added" ? "first-seen" : change.kind,
				detail: change.kind === "added" ? `Added as ${change.stability}.` : change.detail,
				severity: change.severity,
			})
		}
	}

	diffs.reverse()

	const renames = new Map<string, string>()
	for (const a of latest.attributes) {
		if (a.deprecated?.renamedTo) renames.set(a.id, a.deprecated.renamedTo)
	}

	const namespaceCounts = new Map<string, number>()
	for (const a of latest.attributes) namespaceCounts.set(a.namespace, (namespaceCounts.get(a.namespace) ?? 0) + 1)
	const namespaces = [...namespaceCounts.entries()]
		.map(([name, count]) => ({ name, count }))
		.sort((x, y) => x.name.localeCompare(y.name))

	return {
		versions,
		latest,
		diffs,
		releases,
		releaseByTag: new Map(releases.map((r) => [r.tag, r])),
		lifecycle,
		attributes: latest.attributes,
		metrics: latest.metrics,
		signals: latest.signals,
		renames,
		namespaces,
		snapshot: (version) => {
			const found = snapshots.get(version)
			if (!found) throw new Error(`no snapshot for semconv ${version}`)
			return found
		},
		diff: (from, to) => {
			const a = snapshots.get(from)
			const b = snapshots.get(to)
			if (!a || !b) throw new Error(`cannot diff ${from} -> ${to}: missing snapshot`)
			return diffSemconv(a, b)
		},
	}
}
