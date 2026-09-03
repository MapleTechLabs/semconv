import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { gunzipSync, gzipSync } from "node:zlib"
import type { DataIndex, ReleaseRecord, SemconvSnapshot, Snapshot, SourceId } from "../model/types.ts"

/**
 * Deliberately built on `node:` APIs rather than Bun's. The ingest CLI runs
 * under Bun, but Astro prerenders pages in a Node subprocess, and the same
 * reader has to work in both.
 */

/**
 * Resolved from the working directory rather than `import.meta.url`: the Astro
 * build bundles these modules into `dist/.prerender/chunks/`, where a
 * module-relative path points nowhere. Every entry point runs from the repo
 * root; `OTEL_DATA_ROOT` is the escape hatch for anything that does not.
 */
export const DATA_ROOT = process.env["OTEL_DATA_ROOT"] ?? `${process.cwd()}/data/`

const snapshotPath = (source: SourceId, version: string) => `${DATA_ROOT}${source}/${version}.json.gz`

const writeFileEnsuringDir = async (path: string, contents: Uint8Array | string) => {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, contents)
}

/**
 * Snapshots are stored gzipped and committed. Stable key order plus a fixed
 * compression level makes re-ingesting an already-seen tag produce a
 * byte-identical file, so the sync job can treat "git says nothing changed" as
 * "upstream did not move".
 */
export async function writeSnapshot(snapshot: Snapshot): Promise<void> {
	const gz = gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"), { level: 9 })
	await writeFileEnsuringDir(snapshotPath(snapshot.source, snapshot.version), gz)
}

export async function readSnapshot<T extends Snapshot = Snapshot>(source: SourceId, version: string): Promise<T> {
	const gz = await readFile(snapshotPath(source, version))
	return JSON.parse(gunzipSync(gz).toString("utf8")) as T
}

export const readSemconv = (version: string) => readSnapshot<SemconvSnapshot>("semconv", version)

export async function hasSnapshot(source: SourceId, version: string): Promise<boolean> {
	try {
		await readFile(snapshotPath(source, version))
		return true
	} catch {
		return false
	}
}

/** Versions present on disk, newest first. */
export async function listSnapshots(source: SourceId): Promise<string[]> {
	try {
		const files = await readdir(`${DATA_ROOT}${source}`)
		return files
			.filter((f) => f.endsWith(".json.gz"))
			.map((f) => f.replace(/\.json\.gz$/, ""))
			.sort(compareVersions)
			.reverse()
	} catch {
		return []
	}
}

/**
 * Orders both `1.44.0` and the `2026-09-03` dates used for untagged sources, by
 * splitting on either separator. The two never mix within one source, so there
 * is no ambiguity to resolve.
 */
export function compareVersions(a: string, b: string): number {
	const pa = a.split(/[.-]/).map(Number)
	const pb = b.split(/[.-]/).map(Number)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0)
		if (d !== 0) return d
	}
	return 0
}

const INDEX_PATH = `${DATA_ROOT}index.json`

export async function readIndex(): Promise<DataIndex> {
	try {
		return JSON.parse(await readFile(INDEX_PATH, "utf8")) as DataIndex
	} catch {
		return { generatedAt: new Date(0).toISOString(), releases: [] }
	}
}

/**
 * Merges new release records into the index. `generatedAt` deliberately tracks
 * the newest release rather than wall-clock time - a re-run that finds nothing
 * new must not produce a diff.
 */
export async function writeIndex(releases: readonly ReleaseRecord[]): Promise<void> {
	const merged = new Map<string, ReleaseRecord>()
	for (const r of [...(await readIndex()).releases, ...releases]) merged.set(`${r.source}@${r.tag}`, r)
	const sorted = [...merged.values()].sort(
		(a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.source.localeCompare(b.source),
	)
	const index: DataIndex = { generatedAt: sorted[0]?.publishedAt ?? new Date(0).toISOString(), releases: sorted }
	await writeFileEnsuringDir(INDEX_PATH, `${JSON.stringify(index, null, "\t")}\n`)
}
