import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [react(), tailwindcss()],
	// The "@/" alias comes from tsconfig's paths, so no @types/node for path.resolve.
	resolve: { tsconfigPaths: true },
});
