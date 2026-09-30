/**
 * The home page's name checker: the same verdicts `check_attribute_names`
 * gives an agent, computed in the browser from a compact index built at
 * render time. Kept free of catalog imports so it can ship to the client.
 */
export interface NameIndex {
	/** Current keys, in either registry. */
	readonly live: readonly string[]
	/** Deprecated key -> successor, or "" when none is defined. */
	readonly deprecated: Readonly<Record<string, string>>
	/** Template prefixes such as `http.request.header`. */
	readonly templates: readonly string[]
}

export type Verdict =
	| { readonly name: string; readonly status: "ok" }
	| { readonly name: string; readonly status: "template"; readonly prefix: string }
	| { readonly name: string; readonly status: "renamed"; readonly replacement: string }
	| { readonly name: string; readonly status: "deprecated" }
	| { readonly name: string; readonly status: "unknown" }

/** Lowercase, dotted, at least two segments: `http.request.method`, not `span.setAttribute`. */
const KEY = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/

/** Pulls attribute-shaped tokens out of a list or a pasted block of code. */
export const parseNames = (text: string): string[] => [
	...new Set(text.split(/[^A-Za-z0-9_.\-]+/).map((token) => token.replace(/^\.+|\.+$/g, "")).filter((token) => KEY.test(token))),
]

export function checkNames(names: readonly string[], index: NameIndex): Verdict[] {
	const live = new Set(index.live)
	return names.map((name): Verdict => {
		if (live.has(name)) return { name, status: "ok" }
		if (name in index.deprecated) {
			const replacement = index.deprecated[name]
			return replacement ? { name, status: "renamed", replacement } : { name, status: "deprecated" }
		}
		const prefix = index.templates.find((t) => name.startsWith(`${t}.`))
		return prefix ? { name, status: "template", prefix } : { name, status: "unknown" }
	})
}
