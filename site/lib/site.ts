/**
 * Everything name-shaped lives here so renaming the project is one edit.
 * The domain is still an open decision; `semconv.watch` is the working choice
 * because the registry browser, not the prose mirror, is what people arrive for.
 */
export const SITE = {
	name: "semconv.watch",
	tagline: "What changed in the OpenTelemetry semantic conventions",
	description:
		"A version-by-version record of the OpenTelemetry semantic conventions: every attribute, metric and signal, when it was added, promoted, deprecated or renamed - and what replaced it.",
	builder: "Maple",
	builderUrl: "https://maple.dev",
	repo: "https://github.com/open-telemetry/semantic-conventions",
} as const
