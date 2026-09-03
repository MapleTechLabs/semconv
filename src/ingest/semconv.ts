import { Glob } from "bun"
import { parse } from "yaml"
import type {
	Attribute,
	AttributeUsage,
	Deprecation,
	EnumMember,
	MetricDef,
	SemconvSnapshot,
	SignalDef,
	Stability,
} from "../model/types.ts"

/**
 * Normalizes an extracted semantic-conventions checkout into a snapshot.
 *
 * The model is two overlapping things in one YAML tree: some groups hold the
 * canonical definition of each attribute, and signal groups (span / metric /
 * event / entity) *reference* those attributes with a per-signal requirement
 * level. We keep both -- the definition on the attribute, the references in
 * `usedBy` -- because "is `db.query.text` required on this metric" and "what is
 * `db.query.text`" are different questions and both get asked.
 *
 * Two on-disk formats have to be read, because upstream is mid-migration:
 *
 *   - **definition/1** (the original): everything is a `groups:` list, each entry
 *     carrying a `type`, an `attributes` list that mixes definitions (`id:`) with
 *     references (`ref:`), and an optional `extends:` parent.
 *   - **definition/2** (introduced in v1.44.0, 32 of 250 files at that release):
 *     top-level `attributes:` / `attribute_groups:` / `metrics:` / `spans:`
 *     sections, definitions keyed by `key:` rather than `id:`, and composition via
 *     inline `- ref_group: <id>` entries instead of `extends:`.
 *
 * Both collapse onto the same internal group shape below. Getting this wrong is
 * not a cosmetic problem: reading only format 1 against v1.44.0 makes
 * `server.address` and every `hw.*` metric look *deleted from the registry*,
 * which is precisely the false alarm this whole site exists to avoid raising.
 */

// biome-ignore lint: upstream YAML is untyped by nature; it is narrowed on read.
type Raw = any

const asArray = (v: Raw): Raw[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

const text = (v: Raw): string =>
	typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim()

const examples = (v: Raw): string[] => asArray(v).map((e) => (typeof e === "string" ? e : JSON.stringify(e)))

const deprecation = (v: Raw): Deprecation | undefined => {
	if (!v) return undefined
	// Model files before v1.31 used a bare string here instead of a block.
	if (typeof v === "string") return { reason: "uncategorized", note: v.trim() }
	return {
		reason: text(v.reason) || "uncategorized",
		...(v.renamed_to ? { renamedTo: text(v.renamed_to) } : {}),
		...(v.note ? { note: text(v.note) } : {}),
	}
}

/**
 * `requirement_level` is either a bare string or a single-key object whose value
 * is the condition prose (`{ conditionally_required: "If available." }`). The key
 * is the part that changes meaning, so that is what we keep.
 */
const requirementLevel = (v: Raw): string => {
	if (!v) return "recommended"
	if (typeof v === "string") return v
	return Object.keys(v)[0] ?? "recommended"
}

const enumMembers = (v: Raw): EnumMember[] | undefined => {
	if (!v || typeof v === "string" || !Array.isArray(v.members)) return undefined
	return v.members.map((m: Raw) => ({
		id: text(m.id),
		value: typeof m.value === "number" ? m.value : text(m.value),
		...(m.stability ? { stability: m.stability as Stability } : {}),
		...(m.brief ? { brief: text(m.brief) } : {}),
		...(m.deprecated ? { deprecated: deprecation(m.deprecated) as Deprecation } : {}),
	}))
}

const attributeType = (v: Raw): string => (typeof v === "string" ? v : v?.members ? "enum" : "string")

type GroupType = "attribute_group" | "metric" | "event" | "entity" | "span"

/** One group from either file format, flattened to a single internal shape. */
interface Group {
	readonly file: string
	readonly id: string
	readonly type: GroupType
	readonly raw: Raw
	/** `extends:` and every inline `ref_group:`, merged. */
	readonly parents: readonly string[]
	/** Canonical definitions declared inline by this group. */
	readonly defs: readonly Raw[]
	/** References to attributes defined elsewhere. */
	readonly refs: readonly Raw[]
	/** metric_name / event or entity name / span type. */
	readonly signalName?: string
	/**
	 * True for `metric_refinements` / `span_refinements`: these narrow an existing
	 * signal rather than declaring a new one, so they contribute usage edges but
	 * must not be emitted as signals of their own.
	 */
	readonly refinement: boolean
}

const splitAttributes = (raw: Raw) => {
	const entries = asArray(raw?.attributes)
	return {
		refGroups: entries.filter((e) => e?.ref_group).map((e) => text(e.ref_group)),
		defs: entries.filter((e) => e?.id || e?.key),
		refs: entries.filter((e) => e?.ref),
	}
}

const makeGroup = (file: string, id: string, type: GroupType, raw: Raw, extra: Partial<Group> = {}): Group => {
	const { refGroups, defs, refs } = splitAttributes(raw)
	return {
		file,
		id,
		type,
		raw,
		parents: raw?.extends ? [text(raw.extends), ...refGroups] : refGroups,
		defs,
		refs,
		refinement: false,
		...extra,
	}
}

const V1_GROUP_TYPES: Record<string, GroupType> = {
	attribute_group: "attribute_group",
	metric: "metric",
	metric_group: "attribute_group",
	event: "event",
	entity: "entity",
	span: "span",
	scope: "attribute_group",
	resource: "attribute_group",
}

function loadFile(file: string, doc: Raw): Group[] {
	if (!doc) return []

	// definition/1 -- one flat `groups:` list.
	if (Array.isArray(doc.groups)) {
		return doc.groups.map((g: Raw) => {
			const type = V1_GROUP_TYPES[text(g.type)] ?? "attribute_group"
			const signalName = text(g.metric_name) || text(g.name) || undefined
			return makeGroup(file, text(g.id), type, g, signalName ? { signalName } : {})
		})
	}

	// definition/2 -- typed top-level sections.
	const out: Group[] = []

	// A bare `attributes:` section is the registry itself: definitions only, no
	// enclosing group. Synthesize one keyed by file so ids stay unique.
	if (Array.isArray(doc.attributes)) {
		out.push(makeGroup(file, `file:${file}`, "attribute_group", { attributes: doc.attributes }))
	}

	for (const g of asArray(doc.attribute_groups)) {
		out.push(makeGroup(file, text(g.id), "attribute_group", g))
	}
	for (const m of asArray(doc.metrics)) {
		out.push(makeGroup(file, `metric.${text(m.name)}`, "metric", m, { signalName: text(m.name) }))
	}
	for (const m of asArray(doc.metric_refinements)) {
		out.push(makeGroup(file, text(m.id), "metric", m, { signalName: text(m.ref), refinement: true }))
	}
	for (const s of asArray(doc.spans)) {
		out.push(makeGroup(file, text(s.type), "span", s, { signalName: text(s.type) }))
	}
	for (const s of asArray(doc.span_refinements)) {
		out.push(makeGroup(file, text(s.id), "span", s, { signalName: text(s.ref), refinement: true }))
	}
	for (const e of asArray(doc.events)) {
		out.push(makeGroup(file, `event.${text(e.name)}`, "event", e, { signalName: text(e.name) }))
	}
	for (const e of asArray(doc.entities)) {
		out.push(makeGroup(file, `entity.${text(e.name)}`, "entity", e, { signalName: text(e.name) }))
	}

	return out
}

export async function normalizeSemconv(
	root: string,
	meta: { tag: string; version: string; publishedAt: string },
): Promise<SemconvSnapshot> {
	const modelRoot = `${root}/model`
	const files: string[] = []
	for await (const rel of new Glob("**/*.yaml").scan(modelRoot)) files.push(rel)
	files.sort()

	const groups: Group[] = []
	for (const rel of files) {
		const doc: Raw = parse(await Bun.file(`${modelRoot}/${rel}`).text())
		groups.push(...loadFile(`model/${rel}`, doc))
	}

	const byId = new Map<string, Group>()
	for (const g of groups) if (g.id) byId.set(g.id, g)

	/**
	 * A group's effective reference list is its own plus everything it inherits
	 * through `extends` / `ref_group`. Without following the chain, a metric like
	 * `db.client.operation.duration` would appear to carry four attributes when it
	 * actually carries a dozen.
	 */
	const resolveRefs = (id: string, seen = new Set<string>()): Raw[] => {
		if (seen.has(id)) return []
		seen.add(id)
		const group = byId.get(id)
		if (!group) return []
		return [...group.parents.flatMap((p) => resolveRefs(p, seen)), ...group.refs]
	}

	const attributes = new Map<string, Attribute & { usedBy: AttributeUsage[] }>()
	const metrics: MetricDef[] = []
	const signals: SignalDef[] = []

	// Pass 1 -- canonical definitions.
	for (const group of groups) {
		for (const raw of group.defs) {
			const id = text(raw.id ?? raw.key)
			if (!id) continue
			const members = enumMembers(raw.type)
			attributes.set(id, {
				id,
				type: attributeType(raw.type),
				...(members ? { enumMembers: members } : {}),
				stability: (raw.stability ?? "development") as Stability,
				brief: text(raw.brief),
				...(raw.note ? { note: text(raw.note) } : {}),
				examples: examples(raw.examples),
				...(raw.deprecated ? { deprecated: deprecation(raw.deprecated) as Deprecation } : {}),
				namespace: id.split(".")[0] ?? id,
				definedIn: group.file,
				usedBy: [],
			})
		}
	}

	// Pass 2 -- signals, and the usage edges back onto the definitions.
	for (const group of groups) {
		const refs = resolveRefs(group.id)
		const attributeIds = [...new Set(refs.map((r) => text(r.ref)).filter(Boolean))].sort()

		for (const ref of refs) {
			const target = attributes.get(text(ref.ref))
			if (!target) continue
			target.usedBy.push({
				groupId: group.id,
				groupType: group.type,
				...(group.signalName ? { signalName: group.signalName } : {}),
				requirementLevel: requirementLevel(ref.requirement_level),
			})
		}

		if (group.refinement || group.type === "attribute_group") continue
		const raw = group.raw

		if (group.type === "metric") {
			metrics.push({
				name: group.signalName ?? group.id,
				instrument: text(raw.instrument),
				unit: text(raw.unit),
				stability: (raw.stability ?? "development") as Stability,
				brief: text(raw.brief),
				...(raw.note ? { note: text(raw.note) } : {}),
				...(raw.deprecated ? { deprecated: deprecation(raw.deprecated) as Deprecation } : {}),
				attributes: attributeIds,
				definedIn: group.file,
			})
			continue
		}

		// definition/2 spans carry SpanKind under `kind:`; definition/1 under `span_kind:`.
		const spanKind = text(raw.span_kind) || text(raw.kind)
		signals.push({
			id: group.id,
			name: group.signalName ?? group.id,
			kind: group.type,
			stability: (raw.stability ?? "development") as Stability,
			brief: text(raw.brief),
			...(raw.note ? { note: text(raw.note) } : {}),
			...(raw.deprecated ? { deprecated: deprecation(raw.deprecated) as Deprecation } : {}),
			...(spanKind ? { spanKind } : {}),
			attributes: attributeIds,
			definedIn: group.file,
		})
	}

	/**
	 * Sorting and de-duplicating everything makes a re-ingest of an already-seen
	 * tag byte-identical, which is what lets the sync job use "did the file
	 * change" as its only signal that upstream moved.
	 */
	const dedupeUsage = (usage: AttributeUsage[]) => {
		const seen = new Map<string, AttributeUsage>()
		for (const u of usage) seen.set(`${u.groupId}|${u.requirementLevel}`, u)
		return [...seen.values()].sort(
			(x, y) => x.groupId.localeCompare(y.groupId) || x.requirementLevel.localeCompare(y.requirementLevel),
		)
	}

	const dedupeByKey = <T>(items: T[], key: (item: T) => string) => {
		const seen = new Map<string, T>()
		for (const item of items) seen.set(key(item), item)
		return [...seen.values()]
	}

	return {
		source: "semconv",
		version: meta.version,
		tag: meta.tag,
		publishedAt: meta.publishedAt,
		attributes: [...attributes.values()]
			.map((a) => ({ ...a, usedBy: dedupeUsage(a.usedBy) }))
			.sort((a, b) => a.id.localeCompare(b.id)),
		metrics: dedupeByKey(metrics, (m) => m.name).sort((a, b) => a.name.localeCompare(b.name)),
		signals: dedupeByKey(signals, (s) => s.id).sort((a, b) => a.id.localeCompare(b.id)),
	}
}
