import { readdir, readFile } from "node:fs/promises"
import type { ProtoEnumValue, ProtoField, ProtoMessage, ProtoSnapshot } from "../model/types.ts"
import { normalizeMarkdownTree } from "./spec.ts"

/**
 * Normalizes the OTLP protocol definitions into a snapshot.
 *
 * A hand-written parser for the proto3 subset these files actually use, rather
 * than a protobuf toolchain: the goal is a diffable record of the wire
 * contract, not code generation, and the eleven files here use a narrow enough
 * slice of the grammar that a dependency would cost more than it saves.
 *
 * The parse keeps what a wire format can break on -- field numbers, types,
 * labels, `oneof` membership, and retired numbers under `reserved` -- and
 * discards everything that cannot: options, imports, package aliases.
 */

interface Scope {
	readonly name: string
	readonly kind: "message" | "enum" | "service"
	readonly fields: ProtoField[]
	readonly values: ProtoEnumValue[]
	readonly reserved: number[]
	readonly comment?: string
	readonly deprecated: boolean
	/** Set while inside a `oneof` block, so its fields record their union. */
	oneof?: string
}

/**
 * Leading `//` comments document the field beneath them. Only the first
 * sentence is kept -- enough to identify the field on a page without carrying
 * the licence header or a paragraph of profiling caveats into every snapshot.
 */
const commentFrom = (lines: string[]): string | undefined => {
	const text = lines
		.map((line) => line.replace(/^\s*\/\/\s?/, "").trim())
		.join(" ")
		.replace(/\s+/g, " ")
		.trim()
	if (text.length === 0) return undefined
	return text.length > 300 ? `${text.slice(0, 299)}...` : text
}

const isDeprecated = (line: string, comment: string | undefined) =>
	/\[\s*deprecated\s*=\s*true\s*\]/.test(line) || /^deprecated[.:]/i.test(comment ?? "")

function parseProtoFile(file: string, source: string): ProtoMessage[] {
	const out: ProtoMessage[] = []
	const stack: Scope[] = []
	let pkg = ""
	let pendingComment: string[] = []

	const qualified = (name: string) => {
		const parents = stack.map((scope) => scope.name.split(".").pop() as string)
		return [pkg, ...parents, name].filter(Boolean).join(".")
	}

	for (const rawLine of source.split("\n")) {
		const line = rawLine.trim()

		if (line.startsWith("//")) {
			pendingComment.push(line)
			continue
		}
		if (line.length === 0) {
			pendingComment = []
			continue
		}

		const comment = commentFrom(pendingComment)
		const takeComment = () => {
			pendingComment = []
			return comment
		}

		if (line.startsWith("package ")) {
			pkg = line.slice(8).replace(/;.*$/, "").trim()
			takeComment()
			continue
		}
		if (line.startsWith("syntax") || line.startsWith("import") || line.startsWith("option ")) {
			takeComment()
			continue
		}

		const opened = line.match(/^(message|enum|service)\s+(\w+)/)
		if (opened) {
			const kind = opened[1] as Scope["kind"]
			const name = opened[2] as string
			const scopeComment = takeComment()
			stack.push({
				name: qualified(name),
				kind,
				fields: [],
				values: [],
				reserved: [],
				...(scopeComment ? { comment: scopeComment } : {}),
				deprecated: /^deprecated[.:]/i.test(scopeComment ?? ""),
			})
			continue
		}

		const scope = stack.at(-1)
		if (!scope) {
			pendingComment = []
			continue
		}

		if (line.startsWith("oneof ")) {
			scope.oneof = line.slice(6).replace(/\s*\{.*$/, "").trim()
			takeComment()
			continue
		}

		if (line.startsWith("}")) {
			// A `oneof` and a nested type both close with `}`; the open union wins.
			if (scope.oneof) {
				scope.oneof = undefined
				pendingComment = []
				continue
			}
			out.push({
				name: scope.name,
				kind: scope.kind,
				file,
				deprecated: scope.deprecated,
				...(scope.comment ? { comment: scope.comment } : {}),
				fields: scope.fields,
				values: scope.values,
				reserved: scope.reserved,
			})
			stack.pop()
			pendingComment = []
			continue
		}

		if (line.startsWith("reserved ")) {
			for (const part of line.slice(9).replace(/;.*$/, "").split(",")) {
				const number = Number(part.trim())
				if (Number.isInteger(number)) scope.reserved.push(number)
			}
			takeComment()
			continue
		}

		if (scope.kind === "enum") {
			const value = line.match(/^(\w+)\s*=\s*(-?\d+)/)
			if (value) {
				scope.values.push({
					name: value[1] as string,
					number: Number(value[2]),
					deprecated: isDeprecated(line, takeComment()),
				})
			}
			continue
		}

		// `[repeated|optional] <type> <name> = <number>[ options];`
		// The type may be dotted and generic (`map<string, string>`).
		const field = line.match(/^(repeated\s+|optional\s+)?([\w.<>, ]+?)\s+(\w+)\s*=\s*(\d+)/)
		if (field) {
			const fieldComment = takeComment()
			scope.fields.push({
				name: field[3] as string,
				number: Number(field[4]),
				type: (field[2] as string).trim(),
				...(field[1] ? { label: (field[1] as string).trim() } : {}),
				...(scope.oneof ? { oneof: scope.oneof } : {}),
				deprecated: isDeprecated(line, fieldComment),
				...(fieldComment ? { comment: fieldComment } : {}),
			})
			continue
		}

		pendingComment = []
	}

	return out
}

async function protoFiles(root: string, prefix = ""): Promise<string[]> {
	const entries = await readdir(`${root}/${prefix}`, { withFileTypes: true })
	const out: string[] = []
	for (const entry of entries) {
		const path = prefix ? `${prefix}/${entry.name}` : entry.name
		if (entry.isDirectory()) out.push(...(await protoFiles(root, path)))
		else if (entry.name.endsWith(".proto")) out.push(path)
	}
	return out
}

export async function normalizeProto(
	root: string,
	meta: { tag: string; version: string; publishedAt: string },
): Promise<ProtoSnapshot> {
	const files = (await protoFiles(`${root}/opentelemetry`)).sort()

	const messages: ProtoMessage[] = []
	for (const file of files) {
		const path = `opentelemetry/${file}`
		messages.push(...parseProtoFile(path, await readFile(`${root}/opentelemetry/${file}`, "utf8")))
	}

	const { documents, sections } = await normalizeMarkdownTree(root, "docs")

	return {
		source: "proto",
		version: meta.version,
		tag: meta.tag,
		publishedAt: meta.publishedAt,
		messages: messages.sort((a, b) => a.name.localeCompare(b.name)),
		documents,
		sections,
	}
}
