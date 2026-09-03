import sitemap from "@astrojs/sitemap"
import tailwind from "@tailwindcss/vite"
import { defineConfig } from "astro/config"

export default defineConfig({
	srcDir: "./site",
	publicDir: "./public",
	output: "static",
	site: "https://semconv.com",
	trailingSlash: "ignore",
	build: { format: "directory" },
	integrations: [
		sitemap({
			// The JSON API is for programs, not crawlers, and 300-odd pairwise diff
			// files would swamp the index without helping anyone find anything.
			filter: (page) => !page.includes("/api/"),
		}),
	],
	vite: { plugins: [tailwind()] },
})
