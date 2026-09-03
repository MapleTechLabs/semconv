import { Glob } from "bun"
import type { DataIndex, ReleaseRecord, SemconvSnapshot, Snapshot, SourceId } from "../model/types.ts"

export const DATA_ROOT = new URL("../../data/", import.meta.url).pathname

const snapshotPath = (source: SourceId, version: string) => `${DATA_ROOT}${source}/${version}.json.gz`

/**
 * Snapshots are stored gzipped and committed. Stable key order plus a fixed
 * compression level makes re-ingesting an already-seen tag produce a
 * byte-identical file, so the sync job can treat "git says nothing changed" as
 * "upstream did not move".
 */
export async function writeSnapshot(snapshot: Snapshot): Promise<void> {
	const json = JSON.stringify(snapshot)
	const gz = Bun.gzipSync(new TextEncoder().encode(json), { level: 9 })
	await Bun.write(snapshotPath(snapshot.source, snapshot.version), gz)
}

export async function readSnapshot<T extends Snapshot = Snapshot>(source: SourceId, version: string): Promise<T> {
	const file = Bun.file(snapshotPath(source, version))
	const gz = new Uint8Array(await file.arrayBuffer())
	return JSON.parse(new TextDecoder().decode(Bun.gunzipSync(gz))) as T
}

export const readSemconv = (version: string) => readSnapshot<SemconvSnapshot>("semconv", version)

export async function hasSnapshot(source: SourceId, version: string): Promise<boolean> {
	return await Bun.file(snapshotPath(source, version)).exists()
}

/** Versions present on disk, newest first. */
export async function listSnapshots(source: SourceId): Promise<string[]> {
	const dir = `${DATA_ROOT}${source}`
	const versions: string[] = []
	try {
		for await (const f of new Glob("*.json.gz").scan(dir)) versions.push(f.replace(/\.json\.gz$/, ""))
	} catch {
		return []
	}
	return versions.sort(compareVersions).reverse()
}

export function compareVersions(a: string, b: string): number {
	const pa = a.split(".").map(Number)
	const pb = b.split(".").map(Number)
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const d = (pa[i] ?? 0) - (pb[i] ?? 0)
		if (d !== 0) return d
	}
	return 0
}

const INDEX_PATH = `${DATA_ROOT}index.json`

export async function readIndex(): Promise<DataIndex> {
	const file = Bun.file(INDEX_PATH)
	if (!(await file.exists())) return { generatedAt: new Date(0).toISOString(), releases: [] }
	return (await file.json()) as DataIndex
}

/**
 * Merges new release records into the index. `generatedAt` deliberately tracks
 * the newest release rather than wall-clock time — a re-run that finds nothing
 * new must not produce a diff.
 */
export async function writeIndex(releases: readonly ReleaseRecord[]): Promise<void> {
	const merged = new Map<string, ReleaseRecord>()
	for (const r of [...(await readIndex()).releases, ...releases]) merged.set(`${r.source}@${r.tag}`, r)
	const sorted = [...merged.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.source.localeCompare(b.source))
	const index: DataIndex = {
		generatedAt: sorted[0]?.publishedAt ?? new Date(0).toISOString(),
		releases: sorted,
	}
	await Bun.write(INDEX_PATH, `${JSON.stringify(index, null, "\t")}\n`)
}
