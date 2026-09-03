import { Effect } from "effect"
import type { ReleaseRecord, SourceId } from "../model/types.ts"
import { fetchTag, listReleases } from "./github.ts"
import { normalizeProto } from "./proto.ts"
import { normalizeSemconv } from "./semconv.ts"
import { normalizeSpec } from "./spec.ts"
import { compareVersions, hasSnapshot, writeIndex, writeSnapshot } from "./store.ts"

/**
 * Backfill floors. Older releases use a model schema different enough that
 * normalizing them would produce misleading diffs — better to have a hard,
 * documented horizon than a subtly wrong one.
 */
const FLOOR: Record<SourceId, string> = { semconv: "1.30.0", spec: "1.42.0", proto: "1.4.0" }

const CACHE = "/tmp/otel-spec-tracker"

const ingest = (source: SourceId, release: ReleaseRecord) =>
	Effect.gen(function* () {
		const root = yield* fetchTag(source, release.tag, CACHE)
		const meta = { tag: release.tag, version: release.version, publishedAt: release.publishedAt }

		const { snapshot, summary } = yield* Effect.promise(async () => {
			switch (source) {
				case "semconv": {
					const s = await normalizeSemconv(root, meta)
					return {
						snapshot: s,
						summary: `${s.attributes.length} attributes, ${s.metrics.length} metrics, ${s.signals.length} signals`,
					}
				}
				case "spec": {
					const s = await normalizeSpec(root, meta)
					const statements = s.sections.reduce((n, section) => n + section.normative.length, 0)
					return {
						snapshot: s,
						summary: `${s.documents.length} documents, ${s.sections.length} sections, ${statements} requirements`,
					}
				}
				case "proto": {
					const s = await normalizeProto(root, meta)
					const statements = s.sections.reduce((n, section) => n + section.normative.length, 0)
					return {
						snapshot: s,
						summary: `${s.messages.length} messages, ${statements} protocol requirements`,
					}
				}
			}
		})

		yield* Effect.promise(() => writeSnapshot(snapshot))
		yield* Effect.log(`${source} ${release.version}: ${summary}`)
	})

const program = Effect.gen(function* () {
	const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
	const force = process.argv.includes("--force")
	const sources: SourceId[] = (only.length > 0 ? only : ["semconv", "spec", "proto"]) as SourceId[]

	const allReleases: ReleaseRecord[] = []

	for (const source of sources) {
		const releases = (yield* listReleases(source)).filter((r) => compareVersions(r.version, FLOOR[source]) >= 0)
		allReleases.push(...releases)
		yield* Effect.log(`${source}: ${releases.length} releases at or above v${FLOOR[source]}`)

		for (const release of releases) {
			if (!force && (yield* Effect.promise(() => hasSnapshot(source, release.version)))) continue
			yield* ingest(source, release)
		}
	}

	yield* Effect.promise(() => writeIndex(allReleases))
	yield* Effect.log("index written")
})

Effect.runPromise(program.pipe(Effect.tapErrorCause(Effect.logError))).catch(() => process.exit(1))
