// Obsidian opens maximized (1.9.2): src/app/window.ts. Run with: node scripts/build-tests.mjs && node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { maximizeOnce, MAXIMIZE_TRIES } = require("./.build/testable.cjs");

function fakeWin(state) {
	const w = { calls: 0, ...state };
	return Object.assign(w, {
		isDestroyed: () => !!w.destroyed, isVisible: () => !!w.visible, isMinimized: () => !!w.minimized,
		isMaximized: () => !!w.maximized, isFullScreen: () => !!w.fullScreen,
		maximize() { w.calls++; w.maximized = true; w.visible = true; },
	});
}
function host(win, extra = {}) {
	return { require: (id) => (id === "@electron/remote" ? { getCurrentWindow: () => win } : undefined), ...extra };
}
// Runs the retries at once instead of every second.
function run(h, stopping = () => false) {
	const queue = [];
	maximizeOnce(stopping, h, (f) => queue.push(f));
	let n = 0;
	while (queue.length) { queue.shift()(); n++; }
	return n;
}

test("a shown window is maximized once", () => {
	const w = fakeWin({ visible: true });
	run(host(w));
	assert.equal(w.calls, 1);
});

test("a second start in the same window (a reload) leaves it alone", () => {
	const w = fakeWin({ visible: true });
	const h = host(w);
	run(h);
	w.maximized = false; // the user made it smaller
	run(h);
	assert.equal(w.calls, 1);
});

test("already maximized, full screen or minimized: nothing", () => {
	for (const s of [{ maximized: true }, { fullScreen: true }, { minimized: true }]) {
		const w = fakeWin({ visible: true, ...s });
		run(host(w));
		assert.equal(w.calls, 0, JSON.stringify(s));
	}
});

test("a window shown a few seconds later is maximized then", () => {
	const w = fakeWin({ visible: false });
	const queue = [];
	maximizeOnce(() => false, host(w), (f) => queue.push(f));
	queue.shift()();
	queue.shift()();
	w.visible = true;
	queue.shift()();
	assert.equal(w.calls, 1);
	assert.equal(queue.length, 0);
});

test("a window that stays hidden (the e2e test Obsidian) is never shown by us", () => {
	const w = fakeWin({ visible: false });
	const retries = run(host(w));
	assert.equal(w.calls, 0);
	assert.equal(retries, MAXIMIZE_TRIES - 1);
});

test("stopping ends the retries", () => {
	const w = fakeWin({ visible: false });
	assert.equal(run(host(w), () => true), 0);
	assert.equal(w.calls, 0);
});

test("no window access, a throwing require or a throwing window: no exception", () => {
	assert.doesNotThrow(() => run({}));
	assert.doesNotThrow(() => run({ require: () => { throw new Error("no remote"); } }));
	const w = fakeWin({ visible: true });
	w.maximize = () => { throw new Error("boom"); };
	assert.doesNotThrow(() => run(host(w)));
});
