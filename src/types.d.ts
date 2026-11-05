// styles.css is bundled into app.ts as text (esbuild loader "text").
declare module "*.css" {
	const s: string;
	export default s;
}

// Set by esbuild: "" in every release build; only test builds set a fault mode.
declare const __VLB_FAULT__: string;
