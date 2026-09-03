import type { Stability } from "../../src/model/types.ts"
import type { Severity } from "../../src/model/diff.ts"

const escapeHtml = (s: string) =>
	s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

/** The tag whose sources relative links in registry prose point at. */
let sourceTag = "main"
export const setSourceTag = (tag: string) => {
	sourceTag = tag
}

const SEMCONV_REPO = "https://github.com/open-telemetry/semantic-conventions"

/**
 * Upstream prose and our own change details use single-backtick code spans and
 * Markdown links. Both are converted; everything else is escaped first, because
 * these strings come from YAML we do not control and nothing else may reach the
 * page as markup.
 *
 * Registry notes link relatively (`/docs/db/database-spans.md#...`), which only
 * resolves on opentelemetry.io. Those are rewritten to the pinned upstream tag
 * so the destination matches the definition being shown.
 */
export function inlineCode(text: string): string {
	return escapeHtml(text)
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_match, label: string, href: string) => {
			const url = href.startsWith("http")
				? href
				: href.startsWith("/")
					? `${SEMCONV_REPO}/blob/${sourceTag}${href}`
					: href
			if (!url.startsWith("http")) return label
			return `<a href="${url}">${label}</a>`
		})
		.replace(/`([^`]+)`/g, '<code class="font-mono text-[0.92em] px-1 py-px rounded bg-rule/50">$1</code>')
}

export const STABILITY_LABEL: Record<string, string> = {
	stable: "Stable",
	release_candidate: "Release candidate",
	development: "Development",
	experimental: "Experimental",
	alpha: "Alpha",
	deprecated: "Deprecated",
}

export function stabilityClass(stability: Stability, deprecated?: boolean): string {
	if (deprecated) return "text-breaking bg-breaking-bg"
	switch (stability) {
		case "stable":
			return "text-stable bg-stable-bg"
		case "release_candidate":
			return "text-rc bg-rc-bg"
		default:
			return "text-muted bg-rule/50"
	}
}

export const SEVERITY_LABEL: Record<Severity, string> = {
	breaking: "Breaking",
	notable: "Notable",
	informational: "Editorial",
}

export function severityClass(severity: Severity): string {
	switch (severity) {
		case "breaking":
			return "text-breaking bg-breaking-bg"
		case "notable":
			return "text-notable bg-notable-bg"
		default:
			return "text-muted bg-rule/50"
	}
}

const KIND_LABEL: Record<string, string> = {
	added: "added",
	removed: "removed",
	renamed: "renamed",
	deprecated: "deprecated",
	undeprecated: "un-deprecated",
	"stability-changed": "stability",
	"type-changed": "type",
	"unit-changed": "unit",
	"instrument-changed": "instrument",
	"enum-members-changed": "enum",
	"brief-changed": "wording",
	"note-changed": "guidance",
	"examples-changed": "examples",
	"first-seen": "added",
}

export const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind

export function formatDate(iso: string): string {
	return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

/** `db.query.text` -> `/attributes/db.query.text`, safe for a static route. */
export const attributeHref = (id: string) => `/attributes/${encodeURIComponent(id)}`
