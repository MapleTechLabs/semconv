import { type Change, type Severity, type SourceDiff, sortChanges, tally } from "./change.ts"
import { diffSpec } from "./diff-spec.ts"
import type { ProtoMessage, ProtoSnapshot } from "./types.ts"

export interface ProtoDiff extends SourceDiff {
	readonly source: "proto"
}

/**
 * Diffs the OTLP wire definitions, plus the protocol prose that ships beside
 * them.
 *
 * Protobuf has no stability ladder, so severity comes from the package path
 * instead: `opentelemetry.proto.trace.v1` is a released wire contract, while
 * `...v1development` is explicitly provisional. Within a released package,
 * almost any change to an existing field is breaking, because both encodings
 * are load-bearing - binary OTLP is keyed on the field *number*, and OTLP/JSON
 * is keyed on the field *name*. Renaming a field breaks JSON clients even
 * though the binary wire format never notices.
 */

const isDevelopment = (name: string) => /\.v\d+development\./.test(name) || name.includes("development")

const bySt = (message: ProtoMessage, whenReleased: Severity, otherwise: Severity): Severity =>
	isDevelopment(message.name) ? otherwise : whenReleased

const stabilityOf = (message: ProtoMessage) => (isDevelopment(message.name) ? "development" : "stable")

export function diffProto(before: ProtoSnapshot, after: ProtoSnapshot): ProtoDiff {
	const changes: Change[] = []
	const messagesBefore = new Map(before.messages.map((m) => [m.name, m]))
	const messagesAfter = new Map(after.messages.map((m) => [m.name, m]))

	for (const [name, message] of messagesBefore) {
		if (messagesAfter.has(name)) continue
		changes.push({
			kind: "removed",
			severity: bySt(message, "breaking", "notable"),
			entity: "message",
			id: name,
			stability: stabilityOf(message),
			detail: `${message.kind} removed from ${message.file}.`,
		})
	}

	for (const [name, message] of messagesAfter) {
		const previous = messagesBefore.get(name)

		if (!previous) {
			changes.push({
				kind: "added",
				severity: "informational",
				entity: "message",
				id: name,
				stability: stabilityOf(message),
				detail: message.comment ?? `New ${message.kind} in ${message.file}.`,
				href: message.file,
			})
			continue
		}

		if (message.deprecated && !previous.deprecated) {
			changes.push({
				kind: "deprecated",
				severity: bySt(message, "notable", "informational"),
				entity: "message",
				id: name,
				stability: stabilityOf(message),
				detail: `${message.kind} marked deprecated.`,
				href: message.file,
			})
		}

		// --- fields ------------------------------------------------------
		const fieldsBefore = new Map(previous.fields.map((f) => [f.name, f]))
		const fieldsAfter = new Map(message.fields.map((f) => [f.name, f]))
		const byNumberBefore = new Map(previous.fields.map((f) => [f.number, f]))
		const byNumberAfter = new Map(message.fields.map((f) => [f.number, f]))

		for (const field of previous.fields) {
			if (fieldsAfter.has(field.name)) continue

			// Same number, different name: a rename. Harmless on the binary wire,
			// breaking for OTLP/JSON, which keys on the name.
			const successor = byNumberAfter.get(field.number)
			if (successor && !fieldsBefore.has(successor.name)) {
				changes.push({
					kind: "field-renamed",
					severity: bySt(message, "breaking", "notable"),
					entity: "field",
					id: `${name}.${field.name}`,
					stability: stabilityOf(message),
					detail: `Renamed to \`${successor.name}\` (field ${field.number} unchanged). Binary OTLP is unaffected; OTLP/JSON keys on the name.`,
					from: field.name,
					to: successor.name,
					renamedTo: `${name}.${successor.name}`,
					href: message.file,
				})
				continue
			}

			changes.push({
				kind: "field-removed",
				severity: bySt(message, "breaking", "notable"),
				entity: "field",
				id: `${name}.${field.name}`,
				stability: stabilityOf(message),
				detail: `Field ${field.number} (\`${field.type}\`) removed.${
					message.reserved.includes(field.number) ? " The number is now reserved." : ""
				}`,
				href: message.file,
			})
		}

		for (const field of message.fields) {
			const previousField = fieldsBefore.get(field.name)

			if (!previousField) {
				// Already reported as the rename above.
				const renamedFrom = byNumberBefore.get(field.number)
				if (renamedFrom && !fieldsAfter.has(renamedFrom.name)) continue
				changes.push({
					kind: "field-added",
					severity: "informational",
					entity: "field",
					id: `${name}.${field.name}`,
					stability: stabilityOf(message),
					detail: `Field ${field.number}, \`${field.label ? `${field.label} ` : ""}${field.type}\`.`,
					href: message.file,
				})
				continue
			}

			if (previousField.number !== field.number) {
				changes.push({
					kind: "field-number-changed",
					severity: bySt(message, "breaking", "notable"),
					entity: "field",
					id: `${name}.${field.name}`,
					stability: stabilityOf(message),
					detail: `Field number changed from ${previousField.number} to ${field.number}. Every previously encoded message decodes wrongly.`,
					from: String(previousField.number),
					to: String(field.number),
					href: message.file,
				})
			}
			if (previousField.type !== field.type) {
				changes.push({
					kind: "field-type-changed",
					severity: bySt(message, "breaking", "notable"),
					entity: "field",
					id: `${name}.${field.name}`,
					stability: stabilityOf(message),
					detail: `Type changed from \`${previousField.type}\` to \`${field.type}\`.`,
					from: previousField.type,
					to: field.type,
					href: message.file,
				})
			}
			if ((previousField.label ?? "") !== (field.label ?? "")) {
				changes.push({
					kind: "field-label-changed",
					severity: bySt(message, "breaking", "notable"),
					entity: "field",
					id: `${name}.${field.name}`,
					stability: stabilityOf(message),
					detail: `Cardinality changed from \`${previousField.label ?? "singular"}\` to \`${field.label ?? "singular"}\`.`,
					from: previousField.label ?? "singular",
					to: field.label ?? "singular",
					href: message.file,
				})
			}
			if (field.deprecated && !previousField.deprecated) {
				changes.push({
					kind: "deprecated",
					severity: bySt(message, "notable", "informational"),
					entity: "field",
					id: `${name}.${field.name}`,
					stability: stabilityOf(message),
					detail: "Field marked deprecated.",
					href: message.file,
				})
			}
		}

		// --- enum values -------------------------------------------------
		const valuesBefore = new Map(previous.values.map((v) => [v.name, v]))
		const valuesAfter = new Map(message.values.map((v) => [v.name, v]))

		for (const value of previous.values) {
			if (valuesAfter.has(value.name)) continue
			changes.push({
				kind: "value-removed",
				severity: bySt(message, "breaking", "notable"),
				entity: "enum value",
				id: `${name}.${value.name}`,
				stability: stabilityOf(message),
				detail: `Enum value ${value.number} removed.`,
				href: message.file,
			})
		}
		for (const value of message.values) {
			const previousValue = valuesBefore.get(value.name)
			if (!previousValue) {
				changes.push({
					kind: "value-added",
					severity: "informational",
					entity: "enum value",
					id: `${name}.${value.name}`,
					stability: stabilityOf(message),
					detail: `Enum value ${value.number} added.`,
					href: message.file,
				})
			} else if (previousValue.number !== value.number) {
				changes.push({
					kind: "field-number-changed",
					severity: bySt(message, "breaking", "notable"),
					entity: "enum value",
					id: `${name}.${value.name}`,
					stability: stabilityOf(message),
					detail: `Enum value renumbered from ${previousValue.number} to ${value.number}.`,
					from: String(previousValue.number),
					to: String(value.number),
					href: message.file,
				})
			}
		}
	}

	// The OTLP protocol prose lives in this repository too, and its MUSTs bind
	// every OTLP server. Reuse the prose differ rather than duplicating it.
	const prose = diffSpec(
		{ ...before, source: "spec", documents: before.documents, sections: before.sections },
		{ ...after, source: "spec", documents: after.documents, sections: after.sections },
	)
	changes.push(...prose.changes)

	sortChanges(changes)
	return { source: "proto", from: before.version, to: after.version, changes, counts: tally(changes) }
}
