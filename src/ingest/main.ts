import { Effect } from "effect"
import { diffProto } from "../model/diff-proto.ts"
import { diffSpec } from "../model/diff-spec.ts"
import { diffSemconv } from "../model/diff.ts"
import type { ReleaseRecord, Snapshot, SourceId } from "../model/types.ts"
import { fetchTag, listCommits, listReleases, UNTAGGED } from "./github.ts"
import { normalizeProto } from "./proto.ts"
import { normalizeSemconv } from "./semconv.ts"
import { normalizeSpec } from "./spec.ts"
import {
	clearSnapshots,
	compareVersions,
	hasSnapshot,
	listSnapshots,
	readSnapshot,
	writeIndex,
	writeSnapshot,
} from "./store.ts"

/**
 * Backfill floors. Older releases use a model schema different enough that
 * normalizing them would produce misleading diffs — better to have a hard,
 * documented horizon than a subtly wrong one. Untagged sources carry their own
 * floor as a commit SHA; see `UNTAGGED`.
 */
const FLOOR: Partial<Record<SourceId, string>> = { semconv: "1.30.0", spec: "1.42.0", proto: "1.4.0" }

const CACHE = "/tmp/otel-spec-tracker"

// biome-ignore lint: each differ is typed to its own snapshot; the map is not.
const DIFFERS = { semconv: diffSemconv, genai: diffSemconv, spec: diffSpec, proto: diffProto } as unknown as Record<
	SourceId,
	(a: any, b: any) => { changes: readonly unknown[] }
>

const normalize = (source: SourceId, root: string, meta: { tag: string; version: string; publishedAt: string }) =>
	Effect.promise(async () => {
		switch (source) {
			case "genai":
			case "semconv": {
				const snapshot = { ...(await normalizeSemconv(root, meta)), source }
				return {
					snapshot: snapshot as Snapshot,
					summary: `${snapshot.attributes.length} attributes, ${snapshot.metrics.length} metrics, ${snapshot.signals.length} signals`,
				}
			}
			case "spec": {
				const snapshot = await normalizeSpec(root, meta)
				const statements = snapshot.sections.reduce((n, section) => n + section.normative.length, 0)
				return {
					snapshot: snapshot as Snapshot,
					summary: `${snapshot.documents.length} documents, ${snapshot.sections.length} sections, ${statements} requirements`,
				}
			}
			case "proto": {
				const snapshot = await normalizeProto(root, meta)
				const statements = snapshot.sections.reduce((n, section) => n + section.normative.length, 0)
				return { snapshot: snapshot as Snapshot, summary: `${snapshot.messages.length} messages, ${statements} protocol requirements` }
			}
		}
	})

const ingest = (source: SourceId, release: ReleaseRecord) =>
	Effect.gen(function* () {
		const root = yield* fetchTag(source, release.tag, CACHE)
		const meta = { tag: release.tag, version: release.version, publishedAt: release.publishedAt }
		const { snapshot, summary } = yield* normalize(source, root, meta)

		yield* Effect.promise(() => writeSnapshot(snapshot))
		yield* Effect.log(`${source} ${release.version} (${release.tag}): ${summary}`)
	})

/**
 * Walks an untagged source's commit history, keeping the commits that actually
 * moved the model.
 *
 * Two things make this different from ingesting a tagged release. The first is
 * that most commits change nothing a reader cares about — a Weaver bump, a link
 * pin, a reflowed brief — so a candidate is kept only when the differ finds
 * something in it. Comparing normalized JSON instead would be stricter than the
 * differ and publish release pages listing no changes at all.
 *
 * The second is versioning. A commit is dated, not numbered, and upstream
 * merges several model changes on a busy day; the second of them takes
 * `2026-05-05.2` so it neither overwrites the first snapshot nor claims its
 * version. The suffix sorts after the bare date under `compareVersions`, which
 * splits on both separators.
 */
const ingestUntagged = (source: SourceId, commits: readonly ReleaseRecord[], force: boolean) =>
	Effect.gen(function* () {
		const differ = DIFFERS[source]
		const kept: ReleaseRecord[] = []

		const onDisk = yield* Effect.promise(() => listSnapshots(source))
		let previous: Snapshot | undefined = onDisk[0] ? yield* Effect.promise(() => readSnapshot(source, onDisk[0] as string)) : undefined

		const taken = new Set(onDisk)
		const versionFor = (date: string) => {
			if (!taken.has(date)) return date
			for (let n = 2; ; n++) if (!taken.has(`${date}.${n}`)) return `${date}.${n}`
		}

		/**
		 * The walk always starts at the floor, so the daily run would otherwise
		 * re-fetch four dozen trees to reach the two commits that are new. The
		 * newest snapshot names the commit it came from, and everything up to and
		 * including that commit was decided on an earlier run.
		 *
		 * Deliberately the commit's position rather than its date: two commits
		 * pushed together carry the same committer timestamp — `ebe3d1f` and
		 * `07bbdbe` do — and a date watermark would skip the second of them for
		 * good. The timestamp is only the fallback for a snapshot whose commit is
		 * no longer in the window at all.
		 */
		const resumeAt = previous ? commits.findIndex((c) => c.tag === previous?.tag) : -1

		for (const [position, commit] of commits.entries()) {
			if (!force && previous) {
				if (resumeAt >= 0 ? position <= resumeAt : commit.publishedAt <= previous.publishedAt) continue
			}

			const root = yield* fetchTag(source, commit.tag, CACHE)
			const { snapshot, summary } = yield* normalize(source, root, {
				tag: commit.tag,
				version: commit.version,
				publishedAt: commit.publishedAt,
			})
			yield* Effect.promise(() => Bun.$`rm -rf ${root}`.quiet())

			if (previous && differ(previous, snapshot).changes.length === 0) {
				yield* Effect.log(`${source}: ${commit.version} (${commit.tag}) leaves the model unchanged`)
				continue
			}

			const version = versionFor(commit.version)
			taken.add(version)
			const written = { ...snapshot, version }
			yield* Effect.promise(() => writeSnapshot(written))
			yield* Effect.log(`${source} ${version} (${commit.tag}): ${summary}`)

			previous = written
			kept.push({ ...commit, version })
		}

		return kept
	})

const program = Effect.gen(function* () {
	const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
	const force = process.argv.includes("--force")
	const sources: SourceId[] = (only.length > 0 ? only : ["semconv", "spec", "proto", "genai"]) as SourceId[]

	const allReleases: ReleaseRecord[] = []
	const rewalked: SourceId[] = []

	for (const source of sources) {
		const untagged = UNTAGGED[source]

		if (untagged) {
			const commits = yield* listCommits(source, untagged)
			yield* Effect.log(
				`${source}: untagged, ${commits.length} commits touching ${untagged.path} since ${untagged.floor} on ${untagged.branch}`,
			)
			// A forced re-walk re-derives the whole history, so the old snapshots go
			// first: which commits produce a distinct model is exactly what a changed
			// normalizer changes.
			if (force) {
				yield* Effect.promise(() => clearSnapshots(source))
				rewalked.push(source)
			}
			// Only commits whose snapshot was kept are recorded, or the index would
			// claim versions that have no data behind them.
			allReleases.push(...(yield* ingestUntagged(source, commits, force)))
			continue
		}

		const floor = FLOOR[source] ?? "0.0.0"
		const releases = (yield* listReleases(source)).filter((r) => compareVersions(r.version, floor) >= 0)
		allReleases.push(...releases)
		yield* Effect.log(`${source}: ${releases.length} releases at or above v${floor}`)

		for (const release of releases) {
			if (!force && (yield* Effect.promise(() => hasSnapshot(source, release.version)))) continue
			yield* ingest(source, release)
		}
	}

	yield* Effect.promise(() => writeIndex(allReleases, rewalked))
	yield* Effect.log("index written")
})

Effect.runPromise(program.pipe(Effect.tapErrorCause(Effect.logError))).catch(() => process.exit(1))
