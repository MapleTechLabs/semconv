import type { APIRoute } from "astro"
import { catalog } from "../../src/model/catalog.ts"
import { SITE } from "../lib/site.ts"

/**
 * Written for a coding agent that has landed here mid-task, usually asking one
 * of two questions: "is this attribute still current" or "what broke between
 * these two versions". Both are answered by a single JSON fetch, so the file
 * leads with those rather than with a tour of the site.
 */
export const GET: APIRoute = async ({ site }) => {
	const data = await catalog()
	const origin = site?.origin ?? `https://${SITE.name}`
	const latest = data.latest.version
	const oldest = data.versions.at(-1)

	const body = `# ${SITE.name}

> ${SITE.description}

Derived from the OpenTelemetry semantic conventions registry (${SITE.repo}), which is
Apache-2.0 licensed. Independent project, built by ${SITE.builder}. Not affiliated with the
OpenTelemetry project or the CNCF.

Currently tracking semantic conventions v${oldest} through v${latest}
(${data.attributes.length} attributes, ${data.metrics.length} metrics, ${data.renames.size} known renames).

## Answering the two common questions

**"Is this attribute name still current?"**
Fetch ${origin}/api/renames.json — every deprecated attribute with the name that replaced it and
the release that did it. It is small enough to hold in context while auditing a codebase. An id
absent from that list is either current or was deprecated without a successor; ${origin}/api/attributes.json
distinguishes the two via each entry's \`deprecated\` field.

**"What changed between the version we targeted and now?"**
Fetch ${origin}/api/diff/FROM...TO.json for any ordered pair of tracked versions, e.g.
${origin}/api/diff/${oldest}...${latest}.json. Each change carries \`kind\`, \`severity\`,
\`entity\`, \`id\`, \`detail\`, and \`renamedTo\` where a successor is known.

## Endpoints

- ${origin}/api/versions.json — tracked releases with publication dates and change counts
- ${origin}/api/attributes.json — every attribute at v${latest} with type, stability and deprecation
- ${origin}/api/attributes/{id}.json — one attribute in full, plus its release-by-release history
- ${origin}/api/renames.json — deprecated name to successor name
- ${origin}/api/diff/{from}...{to}.json — changes between any two tracked versions
- ${origin}/feed.xml — RSS, one entry per release

## Pages

- ${origin}/ — release history, newest first
- ${origin}/attributes — the full registry, filterable
- ${origin}/attributes/{id} — one attribute, its definition, its usage, and its history
- ${origin}/releases/{version} — everything that changed in one release
- ${origin}/diff — compare any two versions
- ${origin}/about — how the data is produced, and what it does not cover

## How to read \`severity\`

- \`breaking\` — removes, renames or walks back something already marked stable or release
  candidate, the tier where the conventions promise not to do that.
- \`notable\` — the same class of change on a development-stability definition. Expected churn,
  but it will still move data.
- \`informational\` — wording, examples and guidance. No effect on emitted telemetry.

Upstream release notes use their own categories and the two do not always agree; both are shown
on each release page.

## Caveats worth passing on

- History starts at v${oldest}. An attribute reported as first seen there may be considerably older.
- Deprecated attributes remain in the registry. A deprecated name still resolves, so a consumer
  usually has to read both the old and new spelling until instrumentation catches up.
- Only the semantic conventions are covered — not the OpenTelemetry specification prose and not
  the OTLP protocol definitions.
`

	return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } })
}
