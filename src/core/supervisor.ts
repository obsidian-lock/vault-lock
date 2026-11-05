import type { App as ObsidianApp, PluginManifest } from "obsidian";
import {
	ACTIVATE_MS, CORE_VERSION, FIRST_TICK_MS, PROBE_GAP_MS, START_TIMEOUT_MS, STOP_TIMEOUT_MS, SUCCESS_MS, TICK_MS,
} from "../shared/constants";
import { API, App, CoreStatus, Host, RunningInfo } from "../shared/contract";
import { authFor, dav, DavError, errMsg, withTimeout } from "../shared/dav";
import type { VLBSettings } from "../shared/settings";
import { CONTROL } from "../shared/vaultfiles";
import { createBuiltinApp } from "./builtin";
import { Cover } from "./cover";
import { CoreState, defaults, parseCoreConfig, readCoreState, writeCoreState } from "./health";
import { createLifeboat } from "./lifeboat";
import { builtinCandidate, Pick, pick, ServerCandidate } from "./loader";
import type VaultLockPlugin from "./main";

/**
 * Runs one app at a time and keeps the backup going whatever happens to it:
 * - at start it picks an app (loader.pick) and starts it with a time limit; one that throws,
 *   hangs, or leaves the vault unlocked is marked bad and the next one is tried, down to the
 *   lifeboat. The cover stays up until an app has locked the vault (fail closed);
 * - core.json remembers an app that was starting when Obsidian died (crash loop: twice and
 *   it is skipped for 24 h);
 * - every 10 minutes the core tick reads the server's settings for the core (safe mode,
 *   watchdog), runs the watchdog, and picks again; a different choice is switched to at the
 *   next lock (or at once when the lifeboat or a sick app runs, safe mode is ordered, or no
 *   passphrase is set);
 * - the watchdog: when no backup run has finished for the threshold while the server
 *   provably takes writes (two write probes 9 to 20 minutes apart), the app is marked sick and bad.
 */

const RETRY_START_MS = 60_000;
const STOP_FAILED_MS = 10_000;
const CONFIG = `${CONTROL}/config.json`;
const PROBE = `${CONTROL}/core-probe.json`;

type Choice = Pick["choice"];
type Startable = RunningInfo & { create: (host: Host) => App };

export class Supervisor {
	/** The running app (test handle: current.lockScreen, .backup, .privateFolder; the lifeboat's run()). */
	current: App | null = null;
	running: RunningInfo | null = null;
	/** A different choice found by a tick, waiting for the next lock. */
	pending: Pick | null = null;
	/** Public for tests: set back in time to make the watchdog look. */
	lastHeartbeat = 0;
	lastProbeOkAt: number | null = null;
	lastProbe: { at: number; ok: boolean; why: string } | null = null;
	startedAt = 0;
	/** core.json as last read or written. */
	state: CoreState = defaults();
	/** Set while a switch runs; the next switch request waits for it instead. */
	switching: Promise<void> | null = null;
	readonly cover = new Cover();
	private host: HostImpl | null = null;
	/** The app whose start() is still running. */
	private inflight: { app: App | null; host: HostImpl } | null = null;
	private ticking: Promise<void> | null = null;
	/** Apps still being stopped (switch, failed start): the unload waits for them too. */
	private drops = new Set<Promise<void>>();
	private loaded = false;
	/** Unloaded: from then on this copy writes nothing (the next copy owns core.json). */
	private closed = false;
	private successTimer = 0;
	private retryTimer = 0;
	private firstTickTimer = 0;
	private intervals: number[] = [];

	constructor(private plugin: VaultLockPlugin) {}

	get manifest(): PluginManifest {
		return this.plugin.manifest;
	}

	// ---- start -------------------------------------------------------------------

	/** Reads core.json; an app found still "starting" died at its last start (C.2 step 4). */
	loadState(): void {
		this.state = readCoreState(this.plugin.pluginDir);
		this.loaded = true;
		const s = this.state.starting;
		if (!s) return;
		const e = this.state.bad[s.id] ?? { n: 0, at: "", why: "" };
		e.n++;
		e.at = iso();
		e.why = "crash";
		this.state.bad[s.id] = e;
		this.state.starting = null;
		console.error(`[VLB] ${s.id} did not survive its last start (${e.n} time(s) in a row)`);
		this.save();
	}

	/** Starts the best app; first may force the first try (a switch). Nothing started → the cover stays, retried in a minute. */
	async startBest(first?: Choice): Promise<void> {
		window.clearTimeout(this.retryTimer);
		for (let attempt = 1; attempt <= 4 && !this.closed && !this.current; attempt++) {
			const choice = attempt === 1 && first ? first : this.choose().choice;
			if (await this.startCandidate(choice)) return;
		}
		if (this.current || this.closed) return;
		console.error("[VLB] no app could start; the vault stays covered; trying again in a minute");
		this.retryTimer = window.setTimeout(() => void this.startBest(), RETRY_START_MS);
	}

	private async startCandidate(choice: Choice): Promise<boolean> {
		const c = this.candidate(choice);
		if (!c || this.closed) return false;
		const lifeboat = c.kind === "lifeboat";
		// The lifeboat is never marked bad: its failure has nothing after it to record for.
		if (!lifeboat) { this.state.starting = { id: c.id, at: iso() }; this.save(); }
		const host = new HostImpl(this, { id: c.id, kind: c.kind, version: c.version });
		this.inflight = { app: null, host };
		let app: App;
		try {
			app = c.create(host);
			this.inflight.app = app;
			this.plugin.addChild(app);
		} catch (e) {
			return this.fail(c, "load", e, null, host);
		}
		try {
			await within(Promise.resolve().then(() => app.start()), START_TIMEOUT_MS, "start");
		} catch (e) {
			if (this.closed) return this.dropped(app, host);
			return this.fail(c, e instanceof Timeout ? "timeout" : "throw", e, app, host);
		}
		// Unloaded while it started: it did nothing wrong, it just has to go again.
		if (this.closed) return this.dropped(app, host);
		let locked = false;
		try { locked = app.locked(); } catch { /* counts as unlocked */ }
		if (this.plugin.hasPass && !locked) return this.fail(c, "unlocked", null, app, host);

		this.inflight = null;
		this.current = app;
		this.running = { id: c.id, kind: c.kind, version: c.version };
		this.host = host;
		this.lastHeartbeat = this.startedAt = Date.now();
		this.lastProbeOkAt = null;
		if (this.state.sick && this.state.sick.id !== c.id) { this.state.sick = null; this.save(); }
		// Only now: with a passphrase, the vault is locked under the cover.
		this.cover.hide();
		window.clearTimeout(this.successTimer);
		if (!lifeboat) this.successTimer = window.setTimeout(() => this.markGood(c.id), SUCCESS_MS);
		console.log(`[VLB] running ${c.id}`);
		return true;
	}

	private async fail(c: Startable, why: string, err: unknown, app: App | null, host: HostImpl): Promise<false> {
		console.error(`[VLB] ${c.id} did not start (${why}); trying the next one`, err ?? "");
		if (c.kind !== "lifeboat") {
			this.state.bad[c.id] = { n: 2, at: iso(), why };
			this.state.starting = null;
			this.save();
		}
		await this.drop(app, host, STOP_FAILED_MS);
		return false;
	}

	/** The plugin was unloaded while this app started: not its fault, nothing is marked
	 *  (shutdown() has already cleared `starting`). */
	private async dropped(app: App, host: HostImpl): Promise<false> {
		await this.drop(app, host, STOP_FAILED_MS);
		return false;
	}

	private drop(app: App | null, host: HostImpl, ms: number): Promise<void> {
		this.inflight = null;
		const d = this.stopApp(app, host, ms).finally(() => { this.drops.delete(d); });
		this.drops.add(d);
		return d;
	}

	private async stopApp(app: App | null, host: HostImpl, ms: number): Promise<void> {
		if (app) {
			try { await within(Promise.resolve().then(() => app.stop()), ms, "stop"); } catch (e) { console.warn("[VLB] the app did not stop cleanly:", e); }
		}
		host.abort();
		if (app) {
			try { this.plugin.removeChild(app); } catch (e) { console.warn("[VLB] could not remove the app:", e); }
		}
	}

	/** 90 s after a good start: it is not crash-looping. */
	private markGood(id: string): void {
		if (this.running?.id !== id) return;
		if (this.state.starting?.id === id) this.state.starting = null;
		delete this.state.bad[id];
		this.state.lastGood = { id, at: iso() };
		this.save();
	}

	private candidate(choice: Choice): Startable | null {
		const v = this.manifest.version;
		if (choice === "builtin") return { ...builtinCandidate(v), kind: "builtin", create: createBuiltinApp };
		if (choice === "lifeboat") return { id: "lifeboat", kind: "lifeboat", version: v, create: createLifeboat };
		return null; // server bundles: step 4a
	}

	/** The staged server bundle, read and verified from disk (step 4a). */
	private serverCandidate(): ServerCandidate | null {
		return null;
	}

	private choose(): Pick {
		return pick({
			safeMode: this.state.config.safeMode,
			builtin: builtinCandidate(this.manifest.version),
			server: this.serverCandidate(),
			bad: this.state.bad,
			now: Date.now(),
			runningId: this.running?.id,
		});
	}

	private idOf(p: Pick): string {
		if (p.choice === "builtin") return builtinCandidate(this.manifest.version).id;
		if (p.choice === "lifeboat") return "lifeboat";
		return this.serverCandidate()?.id ?? "server:?";
	}

	// ---- switch --------------------------------------------------------------------

	/** Stop the running app and start choice (C.5). A switch already running is returned instead. */
	switchTo(choice: Choice, why: string): Promise<void> {
		if (!this.switching) this.switching = this.doSwitch(choice, why).finally(() => { this.switching = null; });
		return this.switching;
	}

	private async doSwitch(choice: Choice, why: string): Promise<void> {
		if (this.closed) return;
		console.log(`[VLB] switching from ${this.running?.id ?? "nothing"} to ${choice} (${why})`);
		if (this.plugin.hasPass) this.cover.show();
		// It started fine and is being replaced, not crashing: no crash count at the next start.
		const st = this.state.starting;
		if (st && st.id === this.running?.id) { this.state.starting = null; this.save(); }
		const old = this.current, oldHost = this.host;
		this.current = null;
		this.running = null;
		this.host = null;
		window.clearTimeout(this.successTimer);
		// Never two backups at once: the old one has finished (index saved) or can send nothing more.
		if (oldHost) await this.drop(old, oldHost, STOP_TIMEOUT_MS);
		if (this.closed) return;
		await this.startBest(choice);
		this.pending = null;
	}

	// ---- ticks ---------------------------------------------------------------------

	/** After the layout is ready (C.2 step 7). */
	startTicks(): void {
		if (this.closed || this.intervals.length) return;
		this.intervals.push(window.setInterval(() => this.activationTick(), ACTIVATE_MS));
		this.firstTickTimer = window.setTimeout(() => {
			void this.tick();
			this.intervals.push(window.setInterval(() => void this.tick(), TICK_MS));
		}, FIRST_TICK_MS);
	}

	/** C.6: switch to a waiting choice once the vault is locked (or there is no passphrase). */
	activationTick(): void {
		if (this.closed || this.switching || !this.pending || !this.current) return;
		let locked = false;
		try { locked = this.current.locked(); } catch { /* not now */ }
		if (!this.plugin.hasPass || locked) void this.switchTo(this.pending.choice, "activation");
	}

	/** C.4. One at a time: a tick already running is returned instead. Each step on its own. */
	tick(): Promise<void> {
		if (!this.ticking) this.ticking = this.runTick().finally(() => { this.ticking = null; });
		return this.ticking;
	}

	private async runTick(): Promise<void> {
		if (this.closed) return;
		if (this.plugin.settings.webdavUser) {
			try { await this.pollConfig(); } catch (e) { console.warn("[VLB] core: config.json not read:", errMsg(e)); }
			if (this.closed) return;
			// (b) server bundles: step 4a
			try { await this.watchdog(); } catch (e) { console.error("[VLB] watchdog:", e); }
			if (this.closed) return;
		}
		try { await this.repick(); } catch (e) { console.error("[VLB] core: pick:", e); }
		if (this.closed) return;
		this.state.lastUpdateCheck = iso();
		this.save();
	}

	/** config.json "core": 2xx → its values; 404 → defaults; anything else → the last ones. Returns the HTTP status (0: no answer). */
	async pollConfig(): Promise<number> {
		let r;
		try {
			r = await withTimeout(dav(authFor(this.plugin.settings), "GET", CONFIG), 30_000, "GET config.json");
		} catch (e) {
			return e instanceof DavError ? e.status : 0;
		}
		if (r.status === 404) {
			this.state.config = parseCoreConfig(undefined);
			return 404;
		}
		let cfg: unknown;
		try { cfg = JSON.parse(r.text); } catch { return r.status; } // being rewritten: keep the last values
		const before = JSON.stringify(this.state.config);
		this.state.config = parseCoreConfig(cfg && typeof cfg === "object" ? (cfg as Record<string, unknown>).core : undefined);
		if (JSON.stringify(this.state.config) !== before) console.log("[VLB] core settings from the server:", this.state.config);
		return r.status;
	}

	/** C.4 (d): pick again; switch at once when waiting would be wrong, else at the next lock. */
	private async repick(): Promise<void> {
		const r = this.running;
		if (this.closed || this.switching || !r) return;
		const p = this.choose();
		this.pending = this.idOf(p) !== r.id ? p : null;
		if (!this.pending) return;
		const now = r.kind === "lifeboat" || this.state.sick?.id === r.id || !this.plugin.hasPass || p.choice === "lifeboat";
		if (now) await this.switchTo(p.choice, p.why || "tick");
	}

	/**
	 * D.2. Stale = no finished backup run for the threshold. Then the server must prove twice,
	 * at least 9 minutes apart, that it takes writes from this computer, while the app still
	 * wrote nothing: only then is the app to blame (frozen folder, full disk, offline, revoked
	 * login all make the probe fail). Probes more than two ticks apart mean the computer slept
	 * in between (the app had no time to try): the later one counts as the first again. The
	 * lifeboat is restarted, never blamed.
	 */
	async watchdog(): Promise<void> {
		const r = this.running;
		if (!r || this.switching) return;
		const now = Date.now();
		const s = this.plugin.settings;
		const thresholdMs = Math.max(this.state.config.watchdogMinutes, 3 * Math.max(1, s.reconcileMinutes || 10)) * 60_000;
		if (now - this.lastHeartbeat < thresholdMs) { this.lastProbeOkAt = null; return; }
		const ok = await this.probe();
		if (!ok) { this.lastProbeOkAt = null; return; }
		if (this.lastProbeOkAt === null || now - this.lastProbeOkAt > 2 * TICK_MS) { this.lastProbeOkAt = now; return; }
		if (now - this.lastProbeOkAt < PROBE_GAP_MS || this.lastHeartbeat >= this.lastProbeOkAt) return;
		this.lastProbeOkAt = null;
		if (this.running !== r) return; // switched meanwhile
		if (r.kind === "lifeboat") {
			console.error("[VLB] watchdog: the lifeboat has not backed up although the server takes writes; restarting it");
			await this.switchTo("lifeboat", "lifeboat stale");
			return;
		}
		console.error(`[VLB] watchdog: ${r.id} has not backed up for ${Math.round((now - this.lastHeartbeat) / 60_000)} min although the server takes writes; marking it sick`);
		this.state.bad[r.id] = { n: 2, at: iso(now), why: "watchdog" };
		this.state.sick = { id: r.id, at: iso(now) };
		this.save();
	}

	/** A write with this computer's login: PROPFIND would pass on a frozen (read-only) folder. */
	private async probe(): Promise<boolean> {
		const auth = authFor(this.plugin.settings);
		const at = Date.now();
		try {
			await withTimeout(dav(auth, "MKCOL", CONTROL + "/"), 30_000, "MKCOL _control"); // 405 = already there
			await withTimeout(dav(auth, "PUT", PROBE, JSON.stringify({ at: iso(at), core: CORE_VERSION }), { "Content-Type": "application/json" }), 30_000, "PUT core-probe.json");
			this.lastProbe = { at, ok: true, why: "" };
			return true;
		} catch (e) {
			this.lastProbe = { at, ok: false, why: errMsg(e) };
			console.log("[VLB] watchdog: the server does not take writes now, so the app is not blamed:", errMsg(e));
			return false;
		}
	}

	// ---- stop ------------------------------------------------------------------------

	/** Locked now? A lock screen that cannot answer counts as locked. */
	lockedNow(): boolean {
		try {
			return this.current?.locked() ?? false;
		} catch {
			return true;
		}
	}

	/**
	 * E: never rejects; resolves when every app this copy ran or was stopping has finished its
	 * last backup run, or after 30 s, and from then on it can send nothing. A clean unload is
	 * not a crash, also for an app still starting (it did nothing wrong): `starting` is cleared
	 * right away, synchronously, and that is this copy's last write to core.json.
	 */
	shutdown(): Promise<void> {
		this.clearTimers();
		const st = this.state.starting;
		if (st && (st.id === this.running?.id || st.id === this.inflight?.host.running.id)) {
			this.state.starting = null;
			this.save();
		}
		this.closed = true;
		const c = this.current, host = this.host, fly = this.inflight;
		this.current = null;
		this.running = null;
		this.host = null;
		this.pending = null;
		const stops: Promise<void>[] = [];
		if (host) stops.push(this.drop(c, host, STOP_TIMEOUT_MS));
		if (fly) stops.push(this.drop(fly.app, fly.host, STOP_TIMEOUT_MS));
		// Also a switch or failed start still stopping its app: two copies never write at once.
		return Promise.all([...stops, ...this.drops]).then(() => {});
	}

	/** Obsidian closes or reloads normally: the running app did not crash at start. */
	cleanExit(): void {
		const st = this.state.starting;
		if (st && this.running?.id === st.id) {
			this.state.starting = null;
			this.save();
		}
	}

	private clearTimers(): void {
		window.clearTimeout(this.successTimer);
		window.clearTimeout(this.retryTimer);
		window.clearTimeout(this.firstTickTimer);
		for (const t of this.intervals) window.clearInterval(t);
		this.intervals = [];
	}

	// ---- shared ----------------------------------------------------------------------

	/** Never throws; nothing is written before core.json was read (it would replace it with
	 *  defaults), nor after the unload (a late tick would overwrite the next copy's). */
	save(): void {
		if (!this.loaded || this.closed) return;
		try {
			writeCoreState(this.plugin.pluginDir, this.state);
		} catch (e) {
			console.error("[VLB] could not write core.json", e);
		}
	}

	/** Called by an app's host: only the app that runs (or is starting) counts, never one stopped or stopping. */
	beat(h: HostImpl): void {
		if (h === this.host || h === this.inflight?.host) this.lastHeartbeat = Date.now();
	}

	coreStatus(): CoreStatus {
		const r = this.running;
		const st = this.state;
		return {
			coreVersion: CORE_VERSION,
			running: r?.kind ?? "builtin",
			runningId: r?.id ?? "",
			runningVersion: r?.version ?? "",
			startedAt: this.startedAt ? iso(this.startedAt) : "",
			builtin: this.manifest.version,
			server: null, // step 4a
			pending: this.pending?.choice ?? null,
			bad: JSON.parse(JSON.stringify(st.bad)),
			lastGood: st.lastGood,
			sick: st.sick,
			safeMode: st.config.safeMode,
			watchdogMinutes: st.config.watchdogMinutes,
			lastHeartbeat: this.lastHeartbeat ? iso(this.lastHeartbeat) : null,
			lastUpdateCheck: st.lastUpdateCheck,
			updateError: st.updateError,
			coreInstalled: st.coreInstalled,
		};
	}

	/** For the plugin's host objects. */
	get plug(): VaultLockPlugin {
		return this.plugin;
	}
}

/** What one app gets from the core. abort() is final: the app then makes no more requests. */
export class HostImpl implements Host {
	readonly api = API;
	private aborted = false;

	constructor(private sup: Supervisor, readonly running: RunningInfo) {}

	get app(): ObsidianApp {
		return this.sup.plug.app;
	}
	get manifest(): PluginManifest {
		return this.sup.plug.manifest;
	}
	/** The very object the core saves: the app changes it in place. */
	get settings(): VLBSettings {
		return this.sup.plug.settings;
	}
	saveSettings(): Promise<void> {
		return this.sup.plug.saveSettings();
	}
	heartbeat(): void {
		this.sup.beat(this);
	}
	/** Says what this host was made for, also while its app is still starting. */
	coreStatus(): CoreStatus {
		return { ...this.sup.coreStatus(), running: this.running.kind, runningId: this.running.id, runningVersion: this.running.version };
	}
	isAborted(): boolean {
		return this.aborted;
	}
	abort(): void {
		this.aborted = true;
	}
}

class Timeout extends Error {}

/** Rejects with Timeout after ms. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	let timer = 0;
	const limit = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new Timeout(`${what}: not done in ${Math.round(ms / 1000)} s`)), ms);
	});
	return Promise.race([p, limit]).finally(() => window.clearTimeout(timer));
}

function iso(t = Date.now()): string {
	return new Date(t).toISOString();
}
