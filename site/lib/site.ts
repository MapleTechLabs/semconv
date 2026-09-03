/**
 * Everything name-shaped lives here so renaming the project is one edit.
 * The domain is still an open decision; `semconv.watch` is the working choice
 * because the registry browser, not the prose mirror, is what people arrive for.
 */
export const SITE = {
	name: "semconv.watch",
	tagline: "What changed in OpenTelemetry since you last looked",
	description:
		"A version-by-version record of the OpenTelemetry semantic conventions, specification and OTLP: which attributes were renamed, which requirements appeared in a stable document, and which fields changed on the wire.",
	builder: "Maple",
	builderUrl: "https://maple.dev",
	repo: "https://github.com/open-telemetry/semantic-conventions",
} as const
