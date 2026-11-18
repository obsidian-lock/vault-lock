/** The core's contract level; server bundles carry the lowest one they need (minCore). */
export const CORE_VERSION = 2;
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
/** A cover left behind by an unloading copy of the plugin removes itself after this. */
export const UNLOAD_COVER_MS = 5_000;

// ---- the private folder's encryption ------------------------------------------------

/** After the lock's rename, before encrypting: time for the last edit's upload to read the
 *  plaintext from the hidden folder. An unlock, a stop or the quit task end it at once. */
export const ENC_PAUSE_MS = 5_000;
/** The lock's folder rename is retried this long (a file held open, an antivirus scan). */
export const RENAME_RETRY_MS = 3_000;
export const RENAME_RETRY_STEP_MS = 250;
/** The unlock's rename back is retried this long under "Unlocking…" (Defender scanning fresh files). */
export const SHOW_RENAME_RETRY_MS = 30_000;
/** A per-file rename or unlink failing with EPERM/EACCES/EBUSY is retried this long. */
export const FS_RETRY_MS = 2_000;
export const FS_RETRY_STEP_MS = 250;
/** A folder rename still failing is retried this often while locked. */
export const HIDE_RETRY_MS = 10_000;
/** A file that could not be encrypted is retried this often while locked. */
export const BUSY_RETRY_MS = 60_000;
/** The quit task waits this long for the background encryption. */
export const QUIT_WAIT_MS = 20_000;
/** The private folder deleted or renamed away while unlocked is made again this long after the event. */
export const PRIVATE_RECHECK_MS = 1_000;
/** Making the missing private folder may hold the private folder's job chain this long at most. */
export const CREATE_FOLDER_MS = 10_000;
/** Bigger files are hidden, not encrypted, and reported. */
export const MAX_ENCRYPT_BYTES = MAX_BYTES;
/** The core refuses a server bundle (either slot) older than this: that code would move the
 *  private folder's readable server copies to _trash/ and show encrypted files. */
export const MIN_APP_VERSION = "1.9.0";
