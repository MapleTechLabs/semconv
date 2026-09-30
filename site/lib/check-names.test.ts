import { describe, expect, test } from "bun:test"
import { checkNames, parseNames } from "./check-names.ts"

describe("parseNames", () => {
	test("pulls keys out of pasted code and drops method calls and plain words", () => {
		const code = `span.setAttribute("http.url", url)\nspan.setAttribute('gen_ai.system', "openai");\nk8s.pod.name`
		expect(parseNames(code)).toEqual(["http.url", "gen_ai.system", "k8s.pod.name"])
	})

	test("dedupes and trims trailing dots", () => {
		expect(parseNames("db.statement. db.statement")).toEqual(["db.statement"])
	})
})

describe("checkNames", () => {
	const index = {
		live: ["http.response.status_code", "service.name"],
		deprecated: { "http.status_code": "http.response.status_code", "net.peer.name": "" },
		templates: ["http.request.header"],
	}

	test("gives each kind of key its verdict", () => {
		expect(
			checkNames(["service.name", "http.status_code", "net.peer.name", "http.request.header.x-id", "app.cart.size"], index),
		).toEqual([
			{ name: "service.name", status: "ok" },
			{ name: "http.status_code", status: "renamed", replacement: "http.response.status_code" },
			{ name: "net.peer.name", status: "deprecated" },
			{ name: "http.request.header.x-id", status: "template", prefix: "http.request.header" },
			{ name: "app.cart.size", status: "unknown" },
		])
	})
})
