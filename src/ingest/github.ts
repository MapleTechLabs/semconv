import { FetchHttpClient, HttpClient, HttpClientRequest } from "@effect/platform"
import { Data, Effect, Schedule } from "effect"
import type { ReleaseRecord, SourceId } from "../model/types.ts"

export class UpstreamError extends Data.TaggedError("UpstreamError")<{
	readonly repo: string
	readonly detail: string
	readonly cause?: unknown
}> {}

export const REPOS: Record<SourceId, string> = {
	spec: "open-telemetry/opentelemetry-specification",
	semconv: "open-telemetry/semantic-conventions",
	proto: "open-telemetry/opentelemetry-proto",
	genai: "open-telemetry/semantic-conventions-genai",
}

/**
 * Sources with no tags at all, tracked from their default branch instead.
 *
 * The GenAI conventions were split out of semantic-conventions in v1.44.0 and
 * have not cut a release: no tags, a towncrier CHANGELOG reading only
 * "Unreleased", and `stability: development` on the registry itself. Waiting
 * for a tag would mean tracking nothing, and the attributes are already in
 * production use — so the branch is tracked, dated rather than versioned, and
 * labelled as unreleased everywhere it appears.
 *
 * `path` is the only tree the normalizer reads, so a commit that does not touch
 * it cannot change the model: filtering on it turns thousands of documentation
 * commits into the few dozen worth normalizing.
 *
 * `floor` is the horizon, and it is not cosmetic. The repository was created by
 * filtering the semantic-conventions history, so one commit below `ebe3d1f`
 * ("Prepare standalone GenAI semantic conventions repo") the tree still carries
 * the 52 `aws.*` attributes the standalone repo dropped. Walking across that
 * boundary would report 52 removals the project never made. Everything older is
 * already covered by the tagged semantic-conventions snapshots, which carried
 * `gen_ai.*` until v1.44.0 deprecated it in place.
 */
export interface UntaggedSource {
	readonly branch: string
	readonly path: string
	readonly floor: string
}

export const UNTAGGED: Partial<Record<SourceId, UntaggedSource>> = {
	genai: { branch: "main", path: "model", floor: "ebe3d1f" },
}

/**
 * Unauthenticated GitHub is 60 requests/hour, which a full backfill blows through
 * on the release listing alone. `GITHUB_TOKEN` is optional locally and always set
 * in CI.
 */
const authHeaders = (): Record<string, string> => {
	const token = process.env["GITHUB_TOKEN"] ?? process.env["GH_TOKEN"]
	return {
		accept: "application/vnd.github+json",
		"user-agent": "otel-spec-tracker",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	}
}

const retry = Schedule.exponential("500 millis").pipe(Schedule.compose(Schedule.recurs(4)))

export const listReleases = (source: SourceId): Effect.Effect<ReleaseRecord[], UpstreamError> =>
	Effect.gen(function* () {
		const repo = REPOS[source]
		const client = yield* HttpClient.HttpClient
		const out: ReleaseRecord[] = []

		for (let page = 1; page <= 10; page++) {
			const response = yield* client
				.execute(
					HttpClientRequest.get(`https://api.github.com/repos/${repo}/releases`).pipe(
						HttpClientRequest.setHeaders(authHeaders()),
						HttpClientRequest.setUrlParams({ per_page: "100", page: String(page) }),
					),
				)
				.pipe(Effect.retry(retry))

			// biome-ignore lint: GitHub's response shape is narrowed immediately below.
			const body = (yield* response.json) as any[]
			if (!Array.isArray(body) || body.length === 0) break

			for (const r of body) {
				if (r.draft || r.prerelease) continue
				const tag = String(r.tag_name)
				out.push({
					source,
					tag,
					version: tag.replace(/^v/, ""),
					publishedAt: String(r.published_at),
					url: String(r.html_url),
					body: String(r.body ?? ""),
				})
			}
			if (body.length < 100) break
		}

		return out.sort((a, b) => a.publishedAt.localeCompare(b.publishedAt))
	}).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.mapError((cause) =>
			cause instanceof UpstreamError ? cause : new UpstreamError({ repo: REPOS[source], detail: "release listing failed", cause }),
		),
	)

/**
 * Every commit on an untagged source's branch that touched the model tree,
 * oldest first, back to and including its floor commit.
 *
 * Each becomes a synthetic release: the commit date is the version, so
 * snapshots order chronologically alongside the tagged sources, and the short
 * SHA is kept as the tag so a snapshot always names the exact tree it came
 * from — and so the same tree can be fetched again when a normalizer changes.
 */
export const listCommits = (source: SourceId, untagged: UntaggedSource): Effect.Effect<ReleaseRecord[], UpstreamError> =>
	Effect.gen(function* () {
		const repo = REPOS[source]
		const client = yield* HttpClient.HttpClient
		const out: ReleaseRecord[] = []
		let reachedFloor = false

		for (let page = 1; page <= 10 && !reachedFloor; page++) {
			const response = yield* client
				.execute(
					HttpClientRequest.get(`https://api.github.com/repos/${repo}/commits`).pipe(
						HttpClientRequest.setHeaders(authHeaders()),
						HttpClientRequest.setUrlParams({
							sha: untagged.branch,
							path: untagged.path,
							per_page: "100",
							page: String(page),
						}),
					),
				)
				.pipe(Effect.retry(retry))

			// biome-ignore lint: GitHub's commit shape, narrowed immediately below.
			const body = (yield* response.json) as any[]
			if (!Array.isArray(body) || body.length === 0) break

			for (const c of body) {
				const sha = String(c.sha)
				const tag = sha.slice(0, 7)
				const date = String(c.commit?.committer?.date ?? c.commit?.author?.date ?? "")
				if (!date) return yield* Effect.fail(new UpstreamError({ repo, detail: `commit ${tag} has no date` }))

				out.push({
					source,
					tag,
					// Dated, not versioned: there is nothing to version against.
					version: date.slice(0, 10),
					publishedAt: date,
					url: `https://github.com/${repo}/commit/${sha}`,
					body: String(c.commit?.message ?? "").split("\n")[0] ?? "",
				})

				if (sha.startsWith(untagged.floor)) {
					reachedFloor = true
					break
				}
			}
			if (body.length < 100) break
		}

		if (!reachedFloor) {
			return yield* Effect.fail(
				new UpstreamError({ repo, detail: `floor commit ${untagged.floor} not reached within 10 pages of ${untagged.path}` }),
			)
		}

		return out.reverse()
	}).pipe(
		Effect.provide(FetchHttpClient.layer),
		Effect.mapError((cause) =>
			cause instanceof UpstreamError ? cause : new UpstreamError({ repo: REPOS[source], detail: "commit listing failed", cause }),
		),
	)

/**
 * Downloads a tag's source tarball and extracts it, returning the path of the
 * single top-level directory GitHub wraps it in.
 */
export const fetchTag = (source: SourceId, tag: string, into: string): Effect.Effect<string, UpstreamError> =>
	Effect.gen(function* () {
		const repo = REPOS[source]
		// A hex tag is a commit from an untagged source, not a release.
		const ref = /^[0-9a-f]{7,40}$/.test(tag) ? tag : `refs/tags/${tag}`
		const url = `https://codeload.github.com/${repo}/tar.gz/${ref}`
		const dir = `${into}/${source}-${tag}`

		yield* Effect.tryPromise({
			try: async () => {
				await Bun.$`rm -rf ${dir}`.quiet()
				await Bun.$`mkdir -p ${dir}`.quiet()
				const response = await fetch(url, { headers: authHeaders() })
				if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`)
				const archive = `${dir}.tar.gz`
				await Bun.write(archive, await response.arrayBuffer())
				await Bun.$`tar xzf ${archive} -C ${dir}`.quiet()
				await Bun.$`rm -f ${archive}`.quiet()
			},
			catch: (cause) => new UpstreamError({ repo, detail: `could not fetch ${tag}`, cause }),
		})

		const entries = yield* Effect.tryPromise({
			try: async () => (await Bun.$`ls ${dir}`.text()).trim().split("\n").filter(Boolean),
			catch: (cause) => new UpstreamError({ repo, detail: `empty archive for ${tag}`, cause }),
		})

		const top = entries[0]
		if (entries.length !== 1 || !top) {
			return yield* Effect.fail(new UpstreamError({ repo, detail: `unexpected archive layout for ${tag}` }))
		}
		return `${dir}/${top}`
	})
