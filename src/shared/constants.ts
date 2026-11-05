/** The core's contract level; server bundles carry the lowest one they need (minCore). */
export const CORE_VERSION = 1;
/** App.start() must resolve within this. */
export const START_TIMEOUT_MS = 30_000;
/** App.stop() is awaited at most this long. */
export const STOP_TIMEOUT_MS = 30_000;
/** A start counts as good this long after start() resolved. */
export const SUCCESS_MS = 90_000;
/** A bad candidate is tried again once after this. */
export const BAD_RETRY_MS = 86_400_000;
/** Core tick: config, updates, watchdog. */
export const TICK_MS = 600_000;
/** First core tick, after the layout is ready. */
export const FIRST_TICK_MS = 60_000;
/** Switch to a waiting choice once the vault is locked. */
export const ACTIVATE_MS = 30_000;
/** The second successful write probe must come at least this long after the first. */
export const PROBE_GAP_MS = 540_000;
/** Watchdog threshold in minutes: default, floor, cap. */
export const WATCHDOG_DEFAULT_MIN = 120;
export const WATCHDOG_MIN_MIN = 10;
export const WATCHDOG_MAX_MIN = 10_080;
/** app.js / main.js from the server. */
export const MAX_BUNDLE_BYTES = 2_097_152;
/** Signed manifest file. */
export const MAX_MANIFEST_BYTES = 4_096;
/** Safe mode backup period, and its first run after start. */
export const LIFEBOAT_INTERVAL_MS = 600_000;
export const LIFEBOAT_FIRST_MS = 8_000;
/** Files over this size are not uploaded. */
export const MAX_BYTES = 104_857_600;
/** At start, the lock screen is up at once; the private folder hide (on Windows attrib over
 *  every file) is waited for at most this long, so it never makes a start miss its time limit. */
export const HIDE_WAIT_MS = 5_000;
/** A cover left behind by an unloading copy of the plugin removes itself after this. */
export const UNLOAD_COVER_MS = 5_000;
