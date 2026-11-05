// Test-only entry point: bundled by scripts/build-tests.mjs into scripts/.build/testable.cjs,
// never shipped. Only modules that do not import "obsidian" belong here.
export { pick, isBad, builtinCandidate } from "./loader";
export { readCoreState, writeCoreState, defaults, parseCoreConfig, CORE_FILE } from "./health";
export { cmpVersion } from "../shared/version";
