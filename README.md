# semconv.watch

A version-by-version record of the OpenTelemetry semantic conventions: every attribute, metric and
signal, when it was added, promoted, deprecated or renamed — and what replaced it.

The conventions publish a machine-readable registry in which every deprecated attribute names its
successor. That makes the registry diffable. This repository diffs it at every release, commits the
result, and renders it as a site plus a small JSON API meant to be read by agents as much as people.

## Why

`opentelemetry.io/docs/specs` is prose spread across separately-versioned repositories. It answers
"what does the spec say today" and nothing else. The questions that actually come up building a
backend are different:

- What changed between the version I read and today?
- Is `db.statement` still a thing, and what replaced it?
- When did `deployment.environment` get deprecated?

## Layout

| Path                      | What it is                                                     |
| ------------------------- | -------------------------------------------------------------- |
| `src/ingest/`             | Effect CLI: fetch upstream tags, normalize, write `data/`       |
| `src/model/types.ts`      | The normalized snapshot shape                                   |
| `src/model/diff.ts`       | The diff engine — pure, and the most heavily tested part        |
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

Upstream is mid-migration between `definition/1` (one flat `groups:` list) and `definition/2`
(typed top-level sections, `key:` instead of `id:`, `ref_group:` instead of `extends:`). Both are
read. This is not a detail: v1.44.0 moved `server.*`, `client.*`, `source.*`, `destination.*` and
every `hw.*` metric to the newer format, and a format-1-only reader reports all of them as deleted
from the registry.

## Severity

A change is `breaking` when it removes, renames or walks back a definition already marked `stable`
or `release_candidate` — the tier where the conventions promise not to do that. The same change on
a `development` definition is `notable`. Wording, examples and guidance are `informational`.

Upstream release notes use their own categories and the two do not always agree; both are shown on
each release page.

## Data

Snapshots start at semconv v1.30.0. Earlier releases used a model schema different enough that
diffing across it would report changes the project never made.

Source data is © the OpenTelemetry Authors, licensed Apache-2.0. This is an independent project and
is not affiliated with the OpenTelemetry project, the CNCF, or the Linux Foundation.
