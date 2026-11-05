import esbuild from "esbuild";

// main.js = the core with the built-in app; app.js = the app alone (what the server can send).
const fault = process.env.VLB_FAULT ?? ""; // only test builds set this
const common = {
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2020",
	external: ["obsidian", "electron"],
	logLevel: "info",
	treeShaking: true,
	loader: { ".css": "text" },
	define: { __VLB_FAULT__: JSON.stringify(fault) },
};

await esbuild.build({ ...common, entryPoints: ["src/core/main.ts"], outfile: "main.js" });
await esbuild.build({ ...common, entryPoints: ["src/app/app.ts"], outfile: process.env.VLB_APP_OUT ?? "app.js" });
