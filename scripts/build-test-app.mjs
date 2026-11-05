// Builds app.js with a test fault, for the Mac scenarios and the smoke test:
//   node scripts/build-test-app.mjs MODE... [--out DIR]     (default DIR: scripts/.build)
// writes DIR/app-MODE.js. Modes: throw-start, hang-start, never-lock, no-heartbeat (see
// src/app/app.ts and src/app/backup.ts). Never touches main.js or app.js; never for release.
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MODES = ["throw-start", "hang-start", "never-lock", "no-heartbeat"];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function buildTestApp(mode, outDir = path.join(root, "scripts/.build")) {
	if (!MODES.includes(mode)) throw new Error(`unknown mode ${mode}; one of ${MODES.join(", ")}`);
	const outfile = path.join(outDir, `app-${mode}.js`);
	await esbuild.build({
		absWorkingDir: root,
		entryPoints: ["src/app/app.ts"],
		outfile,
		bundle: true,
		format: "cjs",
		platform: "node",
		target: "es2020",
		external: ["obsidian", "electron"],
		logLevel: "warning",
		loader: { ".css": "text" },
		define: { __VLB_FAULT__: JSON.stringify(mode) },
	});
	return outfile;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2);
	const i = args.indexOf("--out");
	const out = i >= 0 ? path.resolve(args.splice(i, 2)[1] ?? "") : undefined;
	if (args.length === 0) {
		console.error(`usage: node scripts/build-test-app.mjs MODE... [--out DIR]; modes: ${MODES.join(", ")}`);
		process.exit(2);
	}
	for (const m of args) console.log(await buildTestApp(m, out));
}
