/**
 * Everything name-shaped lives here, so renaming the project is one edit.
 * Read by both the Astro pages and the Worker, which is why it sits in `src/`
 * rather than under the site tree.
 */
export const SITE = {
	name: "semconv.com",
	origin: "https://semconv.com",
	tagline: "What changed in OpenTelemetry since you last looked",
	description:
		"A version-by-version record of the OpenTelemetry semantic conventions, specification and OTLP: which attributes were renamed, which requirements appeared in a stable document, and which fields changed on the wire.",
	builder: "Maple",
	builderUrl: "https://maple.dev",
	repo: "https://github.com/open-telemetry/semantic-conventions",
} as const
