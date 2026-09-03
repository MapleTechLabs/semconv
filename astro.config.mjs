import tailwind from "@tailwindcss/vite"
import { defineConfig } from "astro/config"

export default defineConfig({
	srcDir: "./site",
	publicDir: "./public",
	output: "static",
	site: "https://semconv.watch",
	trailingSlash: "ignore",
	build: { format: "directory" },
	vite: { plugins: [tailwind()] },
})
