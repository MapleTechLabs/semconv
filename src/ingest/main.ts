import { Effect } from "effect"
import type { ReleaseRecord, SourceId } from "../model/types.ts"
import { fetchTag, listReleases } from "./github.ts"
import { normalizeSemconv } from "./semconv.ts"
import { compareVersions, hasSnapshot, writeIndex, writeSnapshot } from "./store.ts"

/**
 * Backfill floors. Older releases use a model schema different enough that
 * normalizing them would produce misleading diffs — better to have a hard,
 * documented horizon than a subtly wrong one.
 */
const FLOOR: Record<SourceId, string> = { semconv: "1.30.0", spec: "1.40.0", proto: "1.3.0" }

const CACHE = "/tmp/otel-spec-tracker"

const ingestSemconv = (release: ReleaseRecord) =>
	Effect.gen(function* () {
		const root = yield* fetchTag("semconv", release.tag, CACHE)
		const snapshot = yield* Effect.promise(() =>
			normalizeSemconv(root, { tag: release.tag, version: release.version, publishedAt: release.publishedAt }),
		)
		yield* Effect.promise(() => writeSnapshot(snapshot))
		yield* Effect.log(
			`semconv ${release.version}: ${snapshot.attributes.length} attributes, ${snapshot.metrics.length} metrics, ${snapshot.signals.length} signals`,
		)
	})

const program = Effect.gen(function* () {
	const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
	const force = process.argv.includes("--force")
	const sources: SourceId[] = (only.length > 0 ? only : ["semconv"]) as SourceId[]

	const allReleases: ReleaseRecord[] = []

	for (const source of sources) {
		const releases = (yield* listReleases(source)).filter((r) => compareVersions(r.version, FLOOR[source]) >= 0)
		allReleases.push(...releases)
		yield* Effect.log(`${source}: ${releases.length} releases at or above v${FLOOR[source]}`)

		for (const release of releases) {
			if (!force && (yield* Effect.promise(() => hasSnapshot(source, release.version)))) continue
			if (source === "semconv") yield* ingestSemconv(release)
		}
	}

	yield* Effect.promise(() => writeIndex(allReleases))
	yield* Effect.log("index written")
})

Effect.runPromise(program.pipe(Effect.tapErrorCause(Effect.logError))).catch(() => process.exit(1))
