/**
 * The normalized shape every upstream source is flattened into.
 *
 * Two rules hold this file together:
 *   1. Everything here must survive a JSON round-trip — snapshots are committed
 *      to `data/` and the site builds from them with no network.
 *   2. Nothing here may be lossy in a way the diff engine cares about. If a
 *      field can change between releases and someone would want to be told,
 *      it belongs in the snapshot even if no page renders it yet.
 */

export type SourceId = "semconv" | "spec" | "proto"

/**
 * The spec's own stability ladder, verbatim. `alpha` and `experimental` are
 * legacy spellings still present in a handful of groups; they are kept rather
 * than folded into `development` so a snapshot never claims something the
 * upstream YAML did not say.
 */
export type Stability = "stable" | "release_candidate" | "development" | "alpha" | "experimental" | "deprecated"

export interface Deprecation {
	/** `renamed` is the one the diff engine can act on mechanically. */
	readonly reason: "renamed" | "obsoleted" | "uncategorized" | string
	readonly renamedTo?: string
	readonly note?: string
}

export interface EnumMember {
	readonly id: string
	readonly value: string | number
	readonly stability?: Stability
	readonly brief?: string
	readonly deprecated?: Deprecation
}

/** Where a canonical attribute is referenced from, and how strongly. */
export interface AttributeUsage {
	readonly groupId: string
	readonly groupType: "span" | "metric" | "event" | "entity" | "attribute_group"
	/** metric_name / event name / entity name, when the group has one. */
	readonly signalName?: string
	readonly requirementLevel: string
}

export interface Attribute {
	readonly id: string
	/** `string`, `int`, `template[string]`, … or `enum` when members are present. */
	readonly type: string
	readonly enumMembers?: readonly EnumMember[]
	readonly stability: Stability
	readonly brief: string
	readonly note?: string
	readonly examples: readonly string[]
	readonly deprecated?: Deprecation
	/** First dot-segment: `db`, `http`, `k8s`. Drives navigation and grouping. */
	readonly namespace: string
	/** Model file path, relative to the repo root — used for upstream deep links. */
	readonly definedIn: string
	readonly usedBy: readonly AttributeUsage[]
}

export interface MetricDef {
	readonly name: string
	readonly instrument: string
	readonly unit: string
	readonly stability: Stability
	readonly brief: string
	readonly note?: string
	readonly deprecated?: Deprecation
	readonly attributes: readonly string[]
	readonly definedIn: string
}

export interface SignalDef {
	readonly id: string
	readonly name: string
	readonly kind: "event" | "entity" | "span"
	readonly stability: Stability
	readonly brief: string
	readonly note?: string
	readonly deprecated?: Deprecation
	/** SpanKind, for spans only. */
	readonly spanKind?: string
	readonly attributes: readonly string[]
	readonly definedIn: string
}

export interface SemconvSnapshot {
	readonly source: "semconv"
	readonly version: string
	readonly tag: string
	readonly publishedAt: string
	readonly attributes: readonly Attribute[]
	readonly metrics: readonly MetricDef[]
	readonly signals: readonly SignalDef[]
}

// ---------------------------------------------------------------------------
// Specification prose
// ---------------------------------------------------------------------------

/** RFC 2119 keywords, in the spelling the spec uses. */
export type NormativeLevel =
	| "MUST"
	| "MUST NOT"
	| "REQUIRED"
	| "SHALL"
	| "SHALL NOT"
	| "SHOULD"
	| "SHOULD NOT"
	| "RECOMMENDED"
	| "NOT RECOMMENDED"
	| "MAY"
	| "OPTIONAL"

/**
 * One requirement sentence lifted out of spec prose. `id` is a hash of the
 * normalized text, which is what lets the diff engine tell "this requirement is
 * new" from "this paragraph was reflowed".
 */
export interface NormativeStatement {
	readonly id: string
	readonly level: NormativeLevel
	readonly text: string
	/** `specification/trace/api.md#span-creation` */
	readonly section: string
}

export interface SpecSection {
	/** `specification/trace/api.md#span-creation` - stable across reflows. */
	readonly id: string
	readonly path: string
	readonly anchor: string
	readonly title: string
	readonly depth: number
	/** The document-level `**Status**:` marker, e.g. `Stable`, `Development`. */
	readonly status: string
	/** Character count, a cheap proxy for "this section was substantially rewritten". */
	readonly length: number
	readonly normative: readonly NormativeStatement[]
}

export interface SpecDocument {
	readonly path: string
	readonly title: string
	readonly status: string
}

export interface SpecSnapshot {
	readonly source: "spec"
	readonly version: string
	readonly tag: string
	readonly publishedAt: string
	readonly documents: readonly SpecDocument[]
	readonly sections: readonly SpecSection[]
}

// ---------------------------------------------------------------------------
// OTLP protocol definitions
// ---------------------------------------------------------------------------

export interface ProtoField {
	readonly name: string
	readonly number: number
	readonly type: string
	/** `repeated`, `optional`, or absent for a plain singular field. */
	readonly label?: string
	/** Name of the enclosing `oneof`, when the field is inside one. */
	readonly oneof?: string
	readonly deprecated: boolean
	readonly comment?: string
}

export interface ProtoEnumValue {
	readonly name: string
	readonly number: number
	readonly deprecated: boolean
}

export interface ProtoMessage {
	/** Fully qualified: `opentelemetry.proto.trace.v1.Span`. */
	readonly name: string
	readonly kind: "message" | "enum" | "service"
	readonly file: string
	readonly deprecated: boolean
	readonly comment?: string
	readonly fields: readonly ProtoField[]
	readonly values: readonly ProtoEnumValue[]
	/** Field numbers the message has retired and must never reuse. */
	readonly reserved: readonly number[]
}

export interface ProtoSnapshot {
	readonly source: "proto"
	readonly version: string
	readonly tag: string
	readonly publishedAt: string
	readonly messages: readonly ProtoMessage[]
	/**
	 * The OTLP protocol specification prose, which lives in this repository
	 * rather than the specification one -- `specification/protocol/otlp.md` is a
	 * stub redirecting to the website. Anything implementing an OTLP server is
	 * bound by these MUSTs, so they are tracked alongside the wire definitions.
	 */
	readonly documents: readonly SpecDocument[]
	readonly sections: readonly SpecSection[]
}

export type Snapshot = SemconvSnapshot | SpecSnapshot | ProtoSnapshot

/** One upstream release, as recorded in `data/index.json`. */
export interface ReleaseRecord {
	readonly source: SourceId
	readonly tag: string
	readonly version: string
	readonly publishedAt: string
	readonly url: string
	/** The upstream changelog body, verbatim. Prose context for the computed diff. */
	readonly body: string
}

export interface DataIndex {
	readonly generatedAt: string
	readonly releases: readonly ReleaseRecord[]
}
