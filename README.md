# semconv.com

A version-by-version record of the OpenTelemetry semantic conventions, specification and OTLP.
Diffed at every release, committed, and rendered as a site plus a small JSON API and MCP server
meant to be read by agents as much as by people.

## Why

`opentelemetry.io/docs/specs` answers "what does the spec say today" and nothing else. The
questions that actually come up building a backend are different:

- What changed between the version I read and today?
- Is `db.statement` still a thing, and what replaced it?
- Which MUSTs appeared in a stable document since we shipped?
- Did a field number move on the wire?

## Three sources, three methods

| Source | Read as |
| ------ | ------- |
| `semantic-conventions` | Its machine-readable registry — every attribute carries a stability level and, when deprecated, the name of its successor. |
| `opentelemetry-specification` | Its RFC 2119 requirements. Each MUST/SHOULD/MAY is extracted and hashed, so a new requirement is distinguishable from a reflowed paragraph. Requirements that move between sections are matched across. |
| `opentelemetry-proto` | The `.proto` files themselves — messages, field numbers, types, cardinality, enum values, retired numbers — plus the protocol prose. |

**The OTLP protocol specification is not in the specification repository.**
`specification/protocol/otlp.md` is a stub redirecting to the website; the real 800-line document
ships in `docs/specification.md` of `opentelemetry-proto`. Anything auditing an OTLP server needs
that file, and it is easy to miss.

## Layout

| Path                      | What it is                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `src/ingest/`             | Effect CLI: fetch upstream tags, normalize, write `data/`       |
| `src/model/types.ts`      | The normalized snapshot shape                                   |
| `src/model/change.ts`     | The change vocabulary all three differs share                   |
| `src/model/diff*.ts`      | The diff engines — pure, and the most heavily tested part       |
| `src/model/catalog.ts`    | Build-time aggregation: lifecycles, renames, consecutive diffs  |
| `site/`                   | Astro site (`srcDir`), prerendered to `dist/`                   |
| `data/`                   | Committed, gzipped per-version snapshots                        |

## Commands

```bash
bun install
bun run ingest        # fetch any new upstream releases into data/
bun run test          # diff engine, asserted against real releases
bun run typecheck
bun run dev           # site at http://localhost:4321
bun run build
```

`bun run ingest --force` re-normalizes every tracked release. It should produce a byte-identical
`data/` — snapshots are fully sorted and gzipped at a fixed level precisely so that "the file
changed" is a reliable signal that upstream moved.

## Two model formats

The conventions are mid-migration between `definition/1` (one flat `groups:` list) and
`definition/2` (typed top-level sections, `key:` instead of `id:`, `ref_group:` instead of
`extends:`). Both are read. This is not a detail: v1.44.0 moved `server.*`, `client.*`, `source.*`,
`destination.*` and every `hw.*` metric to the newer format, and a format-1-only reader reports all
of them as deleted from the registry.

## For agents

`/llms.txt` maps the machine-readable surface. `/api/*.json` is generated at build time and served
straight off the CDN. `/mcp` is a public, read-only MCP server (streamable HTTP, no auth, no
session state) whose tools read those same asset files through the Worker's `ASSETS` binding — so
the MCP answers and the pages cannot drift apart.

The tool that earns its keep is `check_attribute_names`: give it the attribute keys a codebase
emits and it reports which are deprecated, renamed, or absent from the registry.

## Severity

`breaking` means: for the conventions, removing or renaming something already marked `stable` or
`release_candidate`; for the specification, adding, dropping or restrengthening a requirement in a
document marked Stable; for OTLP, changing an existing field in a released package. The same change
on a `development` definition is `notable`. Wording, examples and guidance are `informational`.

Both OTLP encodings are load-bearing, which is why nearly any change to an existing field counts:
binary keys on the field *number*, JSON keys on the field *name*. A rename breaks every JSON client
while the binary format never notices.

Upstream release notes use their own categories and the two do not always agree; both are shown on
each release page.

## Deploying

One Worker in front of prerendered assets: `/mcp` is handled by
[`src/mcp/worker.ts`](src/mcp/worker.ts), everything else is served from `dist/`, and the MCP tools
read those same asset files through the `ASSETS` binding — so the API and the pages cannot drift.

```bash
bun run deploy   # build, then wrangler deploy
```

`wrangler.jsonc` declares `semconv.com` and `www.semconv.com` as custom domains, which requires the
zone to be on Cloudflare with this account's nameservers. The Worker 301s `www` to the apex; every
canonical URL, the feed and `llms.txt` point at the apex only.

## Data

Snapshots start at semconv v1.30.0, specification v1.42.0 and OTLP v1.4.0. Earlier releases used
schemas and layouts different enough that diffing across them would report changes the projects
never made.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The contents of `data/` are derived from the OpenTelemetry semantic-conventions, specification and
proto repositories, © The OpenTelemetry Authors, also Apache-2.0.

This is an independent project and is not affiliated with, endorsed by, or sponsored by the
OpenTelemetry project, the CNCF, or the Linux Foundation.
