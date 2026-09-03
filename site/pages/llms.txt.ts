import type { APIRoute } from "astro"
import { catalog } from "../../src/model/catalog.ts"
import { SITE } from "../lib/site.ts"

/**
 * Written for a coding agent that has landed here mid-task, usually asking one
 * of three questions: is this attribute name still current, what changed since
 * the version we targeted, and what does the spec actually require. Each is
 * answered by a single fetch, so the file leads with those rather than with a
 * tour of the site.
 */
export const GET: APIRoute = async ({ site }) => {
	const data = await catalog()
	const origin = site?.origin ?? SITE.origin

	const semconv = data.semconv
	const spec = data.spec
	const proto = data.proto
	const genai = data.genai
	const requirements = spec.latest.sections.reduce((n, section) => n + section.normative.length, 0)

	const body = `# ${SITE.name}

> ${SITE.description}

Derived from four OpenTelemetry repositories, all Apache-2.0 licensed: semantic-conventions,
opentelemetry-specification, opentelemetry-proto, and semantic-conventions-genai. Independent project, built by ${SITE.builder}.
Not affiliated with the OpenTelemetry project or the CNCF.

Currently tracking:
- Semantic conventions v${semconv.versions.at(-1)} to v${semconv.latest.version} - ${semconv.latest.attributes.length} attributes, ${semconv.latest.metrics.length} metrics, ${data.renames.size} known renames
- Specification v${spec.versions.at(-1)} to v${spec.latest.version} - ${spec.latest.documents.length} documents, ${requirements} RFC 2119 requirements
- OTLP v${proto.versions.at(-1)} to v${proto.latest.version} - ${proto.latest.messages.length} wire definitions plus the protocol requirements
- GenAI conventions at ${genai.latest.version} - ${genai.latest.attributes.length} attributes. UNRELEASED: that repository has never cut a
  tag, so it is tracked from its default branch and dated rather than versioned, and everything in
  it is development stability.

## Answering the three common questions

**"Is this attribute name still current?"**
Fetch ${origin}/api/renames.json - every deprecated attribute with the name that replaced it and
the release that did it. Small enough to hold in context while auditing a codebase. An id absent
from that list is either current or was deprecated without a successor;
${origin}/api/attributes.json distinguishes the two via each entry's \`deprecated\` field.

Mind the third case: v1.44.0 moved the entire \`gen_ai.*\` namespace out to the GenAI conventions
repository. Those attributes appear in semantic-conventions as deprecated "Moved to..." stubs while
their live definitions sit in the other registry, so a check that reads only semantic-conventions
reports ~59 attributes in active production use as dead. \`/api/attributes.json\` serves both
registries, each entry tagged with \`registry\`, and \`check_attribute_names\` returns status
\`moved\` for these - meaning current, no code change needed.

**"What changed between the version we targeted and now?"**
Fetch ${origin}/api/diff/{source}/{from}...{to}.json for any ordered pair of tracked versions of
any source, e.g. ${origin}/api/diff/semconv/${semconv.versions.at(-1)}...${semconv.latest.version}.json.
Each change carries \`kind\`, \`severity\`, \`entity\`, \`id\`, \`detail\`, and \`renamedTo\` where a
successor is known.

**"What is involved in instrumenting X?"**
Fetch ${origin}/api/domains.json - the registry grouped by topic. Attributes, metrics and signals
carry the same namespace prefixes, so a domain gathers all three; \`governedBy\` names the parts of
the specification that bind each signal kind. The specification prose never says "database", which
is why a keyword search of it comes back empty: what binds a db span is the trace specification.

**"What does the spec actually require here?"**
Fetch ${origin}/api/requirements.json - every MUST, SHOULD and MAY in the current specification and
in the OTLP protocol document, each with its section and that document's stability status. Note
that the OTLP protocol specification is NOT in the specification repository: it lives in
\`docs/specification.md\` of opentelemetry-proto, and \`specification/protocol/otlp.md\` is a stub
that redirects to the website. Both are covered here.

## MCP

${origin}/mcp is a public, read-only MCP server (streamable HTTP, no auth, no session state).
Tools: list_versions, check_attribute_names, get_attribute, search_attributes, diff_versions,
search_requirements, get_otlp_message.
check_attribute_names takes the attribute keys a codebase emits and reports which are deprecated,
renamed, or absent from the registry - use it instead of answering from training data.

## Endpoints

- ${origin}/api/domains.json - the conventions grouped by topic: every namespace, metric and signal a
  domain owns, plus the specification areas that bind them. Upstream publishes no such grouping
- ${origin}/api/search.json - one index over everything: attributes, metrics, signals, requirements
  and OTLP messages, each with a type and a URL
- ${origin}/api/versions.json - every tracked release of all three sources, with change counts
- ${origin}/api/attributes.json - every semantic-conventions attribute at v${semconv.latest.version}
- ${origin}/api/attributes/{id}.json - one attribute in full, plus its release-by-release history
- ${origin}/api/renames.json - deprecated attribute name to successor name
- ${origin}/api/requirements.json - every RFC 2119 requirement in the spec and in OTLP
- ${origin}/api/otlp.json - OTLP messages, fields, field numbers and enum values
- ${origin}/api/diff/{source}/{from}...{to}.json - changes between any two tracked versions
- ${origin}/feed.xml - RSS, one entry per release across all three sources

## Pages

- ${origin}/ - release history across all three sources, newest first
- ${origin}/domains - the conventions by topic: databases, HTTP, messaging, Kubernetes, GenAI, ...
- ${origin}/domains/{slug} - one topic in full: its attributes, metrics, spans, events and the
  specification requirements that govern them
- ${origin}/search - search attributes, metrics, signals, requirements and OTLP messages at once
- ${origin}/attributes - the semantic-conventions registry, grouped by namespace and filterable
- ${origin}/attributes/{id} - one attribute, its definition, its usage, and its history
- ${origin}/spec - specification documents and their requirements
- ${origin}/otlp - the OTLP wire definitions
- ${origin}/releases/{source}/{version} - everything that changed in one release
- ${origin}/diff - compare any two versions
- ${origin}/about - how the data is produced, and what it does not cover

## How to read \`severity\`

- \`breaking\` - for semantic conventions, removes or renames something already marked stable or
  release candidate; for the specification, adds, drops or restrengthens a requirement in a
  document marked Stable; for OTLP, changes an existing field in a released (non-development)
  package. Both OTLP encodings are load-bearing: binary keys on the field number, JSON keys on the
  field name, so a rename breaks JSON clients even though the binary format never notices.
- \`notable\` - the same class of change on a development-stability definition. Expected churn,
  but it will still move data.
- \`informational\` - wording, examples and guidance. No effect on emitted telemetry.

Upstream release notes use their own categories and the two do not always agree; both are shown
on each release page.

## Caveats worth passing on

- History starts at semconv v${semconv.versions.at(-1)}, spec v${spec.versions.at(-1)}, OTLP
  v${proto.versions.at(-1)}. Anything reported as first seen there may be considerably older.
- Deprecated attributes remain in the registry. A deprecated name still resolves, so a consumer
  usually has to read both the old and new spelling until instrumentation catches up.
- Specification changes are tracked as RFC 2119 requirements, not as prose diffs. A paragraph
  rewritten without changing what it requires will show as editorial.
- Only \`specification/\` is read from the specification repository. \`oteps/\`, \`development/\` and
  \`supplementary-guidelines/\` are proposals and commentary, and their MUSTs do not bind anyone.
`

	return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } })
}
