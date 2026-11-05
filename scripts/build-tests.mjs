// Builds what the tests need into scripts/.build/ (never shipped):
//   testable.cjs           the core's pure parts (src/core/testable.ts) for the node:test tables
//   main-<fault>.js        main.js whose built-in app has a test fault (__VLB_FAULT__), for smoke.mjs
//   app-<fault>.js         app.js with a test fault, served as a server bundle by smoke.mjs
import esbuild from "esbuild";
import { buildTestApp } from "./build-test-app.mjs";

const out = "scripts/.build";
const common = {
	bundle: true,
	format: "cjs",
	platform: "node",
	target: "es2020",
	external: ["obsidian", "electron"],
	logLevel: "warning",
	loader: { ".css": "text" },
};

await esbuild.build({ ...common, entryPoints: ["src/core/testable.ts"], outfile: `${out}/testable.cjs`, define: { __VLB_FAULT__: '""' } });
for (const fault of ["throw-start", "never-lock"]) {
	await esbuild.build({ ...common, entryPoints: ["src/core/main.ts"], outfile: `${out}/main-${fault}.js`, define: { __VLB_FAULT__: JSON.stringify(fault) } });
}
for (const fault of ["throw-start", "never-lock", "no-heartbeat"]) await buildTestApp(fault);
console.log("test builds in scripts/.build/");
