// Builds what the tests need into scripts/.build/ (never shipped):
//   testable.cjs           the core's pure parts (src/core/testable.ts) for the node:test tables
//   updater.cjs            src/core/updater.ts with "obsidian" stubbed (globalThis.__vlbObsidian, set by the test)
//   main-<fault>.js        main.js whose built-in app has a test fault (__VLB_FAULT__), for smoke.mjs
//   main-faults.js         main.js with the fault stops armed (__VLB_FAULT__ "runtime"): a step named in
//                          globalThis.__vlbFault logs "[VLB] fault stop STEP" and hangs (smoke.mjs, e2e step6)
//   app-<fault>.js         app.js with a test fault, served as a server bundle by smoke.mjs
// The repo root's main.js and app.js are never touched here.
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

/** "obsidian" → whatever the test put in globalThis.__vlbObsidian before loading the bundle. */
const obsidianStub = {
	name: "obsidian-stub",
	setup(b) {
		b.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "vlb-stub" }));
		b.onLoad({ filter: /.*/, namespace: "vlb-stub" }, () => ({ contents: "module.exports = globalThis.__vlbObsidian ?? {};", loader: "js" }));
	},
};

await esbuild.build({ ...common, entryPoints: ["src/core/testable.ts"], outfile: `${out}/testable.cjs`, define: { __VLB_FAULT__: '""' } });
await esbuild.build({ ...common, external: ["electron"], plugins: [obsidianStub], entryPoints: ["src/core/updater.ts"], outfile: `${out}/updater.cjs`, define: { __VLB_FAULT__: '""' } });
for (const fault of ["throw-start", "never-lock", "runtime"]) {
	const name = fault === "runtime" ? "faults" : fault;
	await esbuild.build({ ...common, entryPoints: ["src/core/main.ts"], outfile: `${out}/main-${name}.js`, define: { __VLB_FAULT__: JSON.stringify(fault) } });
}
for (const fault of ["throw-start", "never-lock", "no-heartbeat", "runtime"]) await buildTestApp(fault);
console.log("test builds in scripts/.build/");
