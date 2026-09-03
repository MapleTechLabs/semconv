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
 * Downloads a tag's source tarball and extracts it, returning the path of the
 * single top-level directory GitHub wraps it in.
 */
export const fetchTag = (source: SourceId, tag: string, into: string): Effect.Effect<string, UpstreamError> =>
	Effect.gen(function* () {
		const repo = REPOS[source]
		const url = `https://codeload.github.com/${repo}/tar.gz/refs/tags/${tag}`
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
