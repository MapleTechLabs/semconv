import { Effect } from "effect"
import type { ReleaseRecord, SourceId } from "../model/types.ts"
import { fetchTag, headOfBranch, listReleases, UNTAGGED } from "./github.ts"
import { normalizeProto } from "./proto.ts"
import { normalizeSemconv } from "./semconv.ts"
import { normalizeSpec } from "./spec.ts"
import { compareVersions, hasSnapshot, listSnapshots, readSnapshot, writeIndex, writeSnapshot } from "./store.ts"

/**
 * Backfill floors. Older releases use a model schema different enough that
 * normalizing them would produce misleading diffs — better to have a hard,
 * documented horizon than a subtly wrong one.
 */
const FLOOR: Partial<Record<SourceId, string>> = { semconv: "1.30.0", spec: "1.42.0", proto: "1.4.0" }

const CACHE = "/tmp/otel-spec-tracker"

const ingest = (source: SourceId, release: ReleaseRecord) =>
	Effect.gen(function* () {
		const root = yield* fetchTag(source, release.tag, CACHE)
		const meta = { tag: release.tag, version: release.version, publishedAt: release.publishedAt }

		const { snapshot, summary } = yield* Effect.promise(async () => {
			switch (source) {
				case "genai":
				case "semconv": {
					const s = { ...(await normalizeSemconv(root, meta)), source }
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

		/**
		 * An untagged source is re-read from its branch on every run, so most days
		 * produce a snapshot identical to the last one. Comparing content — not
		 * dates — is what keeps `data/` proportional to real change rather than to
		 * the calendar.
		 */
		if (UNTAGGED[source]) {
			const previous = (yield* Effect.promise(() => listSnapshots(source)))[0]
			if (previous) {
				const before = yield* Effect.promise(() => readSnapshot(source, previous))
				const identical = (a: object, b: object) =>
					JSON.stringify({ ...a, version: "", tag: "", publishedAt: "" }) ===
					JSON.stringify({ ...b, version: "", tag: "", publishedAt: "" })
				if (identical(before, snapshot)) {
					yield* Effect.log(`${source}: no model change since ${previous}`)
					return false
				}
			}
		}

		yield* Effect.promise(() => writeSnapshot(snapshot))
		yield* Effect.log(`${source} ${release.version} (${release.tag}): ${summary}`)
		return true
	})

const program = Effect.gen(function* () {
	const only = process.argv.slice(2).filter((a) => !a.startsWith("-"))
	const force = process.argv.includes("--force")
	const sources: SourceId[] = (only.length > 0 ? only : ["semconv", "spec", "proto", "genai"]) as SourceId[]

	const allReleases: ReleaseRecord[] = []

	for (const source of sources) {
		const branch = UNTAGGED[source]

		if (branch) {
			const head = yield* headOfBranch(source, branch)
			yield* Effect.log(`${source}: untagged, tracking ${branch} at ${head.tag} (${head.version})`)
			const wrote = yield* ingest(source, head)
			// Only record the pseudo-release when its snapshot was actually kept,
			// or the index would claim a version that has no data behind it.
			if (wrote) allReleases.push(head)
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

	yield* Effect.promise(() => writeIndex(allReleases))
	yield* Effect.log("index written")
})

Effect.runPromise(program.pipe(Effect.tapErrorCause(Effect.logError))).catch(() => process.exit(1))
