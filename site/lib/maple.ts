import { MapleBrowser } from "@maple-dev/browser"

MapleBrowser.init({
	// Public, write-only ingest key (maple_pk_…). MAPLE_TEST is accepted by ingest and stores nothing.
	ingestKey: "MAPLE_TEST",
	serviceName: "semconv-web",
	region: "us",
	environment: import.meta.env.MODE,
})
