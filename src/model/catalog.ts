import { listSnapshots, readIndex, readSnapshot } from "../ingest/store.ts"
import type { Change, SourceDiff } from "./change.ts"
import { diffSemconv } from "./diff.ts"
import { diffProto } from "./diff-proto.ts"
import { diffSpec } from "./diff-spec.ts"
import type {
	Attribute,
	MetricDef,
	ProtoSnapshot,
	ReleaseRecord,
	SemconvSnapshot,
	SignalDef,
	Snapshot,
	SourceId,
	SpecSnapshot,
} from "./types.ts"

/**
 * Everything the site renders, assembled once from the committed snapshots.
 *
 * Deliberately eager and in-memory: three sources and forty-odd releases is a
 * few megabytes decompressed, and having the whole history resident is what
 * makes per-attribute lifecycles and arbitrary version comparisons cheap. Built
 * once per `astro build` and shared by every page.
 */

export const SOURCES: readonly SourceId[] = ["semconv", "spec", "proto", "genai"]

export const SOURCE_LABEL: Record<SourceId, string> = {
	semconv: "Semantic conventions",
	spec: "Specification",
	proto: "OTLP",
	genai: "GenAI conventions",
}

/**
 * Sources tracked from a branch rather than from tags, dated instead of
 * versioned. Everything that renders a version needs to say so, or a reader
 * will take an unreleased change for a shipped one.
 */
export const UNRELEASED: Partial<Record<SourceId, true>> = { genai: true }

export const SOURCE_REPO: Record<SourceId, string> = {
	semconv: "https://github.com/open-telemetry/semantic-conventions",
	spec: "https://github.com/open-telemetry/opentelemetry-specification",
	proto: "https://github.com/open-telemetry/opentelemetry-proto",
	genai: "https://github.com/open-telemetry/semantic-conventions-genai",
}

export interface LifecycleEvent {
	readonly version: string
	readonly publishedAt: string
	readonly kind: Change["kind"] | "first-seen"
	readonly detail: string
	readonly severity?: Change["severity"]
}

export interface SourceCatalog<T extends Snapshot = Snapshot> {
	readonly id: SourceId
	/** Newest first. */
	readonly versions: readonly string[]
	readonly latest: T
	/** Consecutive-release diffs, newest first. */
	readonly diffs: readonly SourceDiff[]
	readonly releases: readonly ReleaseRecord[]
	snapshot(version: string): T
	diff(from: string, to: string): SourceDiff
	release(version: string): ReleaseRecord | undefined
}

/** One release across any source, for the combined change feed. */
export interface FeedEntry {
	readonly source: SourceId
	readonly version: string
	readonly publishedAt: string
	readonly diff: SourceDiff
	readonly release: ReleaseRecord | undefined
}

export interface Catalog {
	readonly semconv: SourceCatalog<SemconvSnapshot>
	readonly spec: SourceCatalog<SpecSnapshot>
	readonly proto: SourceCatalog<ProtoSnapshot>
	readonly genai: SourceCatalog<SemconvSnapshot>
	source(id: SourceId): SourceCatalog
	/** Every release across every source, newest first. */
	readonly feed: readonly FeedEntry[]

	// Semantic-conventions views, used by the registry pages.
	readonly attributes: readonly Attribute[]
	readonly metrics: readonly MetricDef[]
	readonly signals: readonly SignalDef[]
	/** Attribute id -> its history, oldest first. */
	readonly lifecycle: ReadonlyMap<string, readonly LifecycleEvent[]>
	/** Deprecated attribute -> its successor. */
	readonly renames: ReadonlyMap<string, string>
	/**
	 * Attributes the GenAI registry defines, live, keyed by id. 59 of them also
	 * exist in semantic-conventions as deprecated "Moved to..." stubs, so this is
	 * what tells a page that a dead-looking attribute is alive elsewhere.
	 */
	readonly genaiLive: ReadonlyMap<string, Attribute>
	readonly namespaces: readonly { readonly name: string; readonly count: number }[]
}

let cached: Promise<Catalog> | undefined

export function catalog(): Promise<Catalog> {
	cached ??= build()
	return cached
}

const DIFFERS = {
	semconv: diffSemconv,
	// Same registry model, so the same differ; only the provenance differs.
	genai: diffSemconv,
	spec: diffSpec,
	proto: diffProto,
	// biome-ignore lint: each differ is typed to its own snapshot; the map is not.
} as unknown as Record<SourceId, (a: any, b: any) => SourceDiff>

async function buildSource<T extends Snapshot>(id: SourceId, releases: readonly ReleaseRecord[]): Promise<SourceCatalog<T>> {
	const versions = await listSnapshots(id)
	if (versions.length === 0) throw new Error(`no ${id} snapshots in data/ - run \`bun run ingest\` first`)

	const snapshots = new Map<string, T>()
	for (const version of versions) snapshots.set(version, await readSnapshot<T>(id, version))

	const mine = releases.filter((r) => r.source === id)
	const byVersion = new Map(mine.map((r) => [r.version, r]))
	const differ = DIFFERS[id]

	const diffs: SourceDiff[] = []
	const oldestFirst = [...versions].reverse()
	for (let i = 1; i < oldestFirst.length; i++) {
		diffs.push(differ(snapshots.get(oldestFirst[i - 1] as string), snapshots.get(oldestFirst[i] as string)))
	}
	diffs.reverse()

	const snapshot = (version: string) => {
		const found = snapshots.get(version)
		if (!found) throw new Error(`no ${id} snapshot for ${version}`)
		return found
	}

	return {
		id,
		versions,
		latest: snapshot(versions[0] as string),
		diffs,
		releases: mine,
		snapshot,
		diff: (from, to) => differ(snapshot(from), snapshot(to)),
		release: (version) => byVersion.get(version),
	}
}

async function build(): Promise<Catalog> {
	const index = await readIndex()

	const semconv = await buildSource<SemconvSnapshot>("semconv", index.releases)
	const spec = await buildSource<SpecSnapshot>("spec", index.releases)
	const proto = await buildSource<ProtoSnapshot>("proto", index.releases)
	const genai = await buildSource<SemconvSnapshot>("genai", index.releases)

	const sources: Record<SourceId, SourceCatalog> = { semconv, spec, proto, genai }

	const feed: FeedEntry[] = SOURCES.flatMap((id) =>
		sources[id].diffs.map((diff) => {
			const release = sources[id].release(diff.to)
			return {
				source: id,
				version: diff.to,
				publishedAt: release?.publishedAt ?? "",
				diff,
				release,
			}
		}),
	).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))

	// --- semantic-conventions lifecycles ---------------------------------
	const lifecycle = new Map<string, LifecycleEvent[]>()
	const push = (id: string, event: LifecycleEvent) => {
		const events = lifecycle.get(id)
		if (events) events.push(event)
		else lifecycle.set(id, [event])
	}

	const oldest = semconv.snapshot(semconv.versions.at(-1) as string)
	const oldestPublished = semconv.release(oldest.version)?.publishedAt ?? oldest.publishedAt
	for (const attribute of oldest.attributes) {
		push(attribute.id, {
			version: oldest.version,
			publishedAt: oldestPublished,
			kind: "first-seen",
			// The floor is a choice we made, not a fact about the spec, so the copy
			// has to be honest that the attribute may well predate it.
			detail: `Already present at v${oldest.version}, the oldest release tracked here (${attribute.stability}).`,
		})
	}

	for (const diff of [...semconv.diffs].reverse()) {
		const publishedAt = semconv.release(diff.to)?.publishedAt ?? ""
		for (const change of diff.changes) {
			if (change.kind === "note-changed" || change.kind === "brief-changed" || change.kind === "examples-changed") {
				continue
			}
			push(change.id, {
				version: diff.to,
				publishedAt,
				kind: change.kind === "added" ? "first-seen" : change.kind,
				detail: change.kind === "added" ? `Added as ${change.stability}.` : change.detail,
				severity: change.severity,
			})
		}
	}

	const genaiLive = new Map<string, Attribute>()
	for (const attribute of genai.latest.attributes) {
		if (!attribute.deprecated) genaiLive.set(attribute.id, attribute)
	}

	const renames = new Map<string, string>()
	for (const attribute of semconv.latest.attributes) {
		if (attribute.deprecated?.renamedTo) renames.set(attribute.id, attribute.deprecated.renamedTo)
	}

	const namespaceCounts = new Map<string, number>()
	for (const attribute of semconv.latest.attributes) {
		namespaceCounts.set(attribute.namespace, (namespaceCounts.get(attribute.namespace) ?? 0) + 1)
	}

	return {
		semconv,
		spec,
		proto,
		genai,
		source: (id) => sources[id],
		feed,
		attributes: semconv.latest.attributes,
		metrics: semconv.latest.metrics,
		signals: semconv.latest.signals,
		lifecycle,
		renames,
		genaiLive,
		namespaces: [...namespaceCounts.entries()]
			.map(([name, count]) => ({ name, count }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	}
}
