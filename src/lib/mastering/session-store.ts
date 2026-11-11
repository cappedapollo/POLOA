import type { MonitorMode } from "@/lib/mastering/graph";

const SETTINGS_KEY = "poloa.mastering.session.v1";
const CHAIN_KEY = "poloa.mastering.chain.v1";
const DB_NAME = "poloa-mastering";
const STORE = "songs";
const CURRENT = "current";

/** Everything about the desk that is not the chain or the song. */
export interface SavedSettings {
  dim: boolean;
  inputGainDb: number;
  listenSource: boolean;
  loop: { on: boolean; region: readonly [number, number] };
  markers: number[];
  matchLevel: boolean;
  monitor: MonitorMode;
  /** Where the playhead was, in seconds. */
  position: number;
  target: number;
  volumeDb: number;
  vuReference: number;
}

export const DEFAULT_SETTINGS: SavedSettings = {
  dim: false,
  inputGainDb: 0,
  listenSource: false,
  loop: { on: false, region: [0, 0] },
  markers: [],
  matchLevel: true,
  monitor: "stereo",
  position: 0,
  target: -14,
  volumeDb: -6,
  vuReference: -18,
};

const MONITOR_MODES: readonly MonitorMode[] = ["stereo", "mono", "side", "left", "right", "swap"];

const num = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, value))
    : fallback;
const bool = (value: unknown, fallback: boolean) =>
  typeof value === "boolean" ? value : fallback;

/** The saved settings, each one checked and the missing or broken ones at their defaults. */
export function loadSettings(): SavedSettings {
  let saved: Record<string, unknown> = {};
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") ?? {};
  } catch {
    // A broken save falls back to the defaults.
  }
  const d = DEFAULT_SETTINGS;
  const loop = (saved.loop ?? {}) as { on?: unknown; region?: unknown };
  const region = Array.isArray(loop.region) ? loop.region : [];
  const start = num(region[0], 0, 0, Number.MAX_SAFE_INTEGER);
  const end = num(region[1], 0, 0, Number.MAX_SAFE_INTEGER);
  return {
    dim: bool(saved.dim, d.dim),
    inputGainDb: num(saved.inputGainDb, d.inputGainDb, -24, 24),
    listenSource: bool(saved.listenSource, d.listenSource),
    loop: { on: bool(loop.on, false), region: end > start ? [start, end] : [0, 0] },
    markers: Array.isArray(saved.markers)
      ? saved.markers.filter((time): time is number => typeof time === "number" && time >= 0)
      : [],
    matchLevel: bool(saved.matchLevel, d.matchLevel),
    monitor: MONITOR_MODES.includes(saved.monitor as MonitorMode)
      ? (saved.monitor as MonitorMode)
      : d.monitor,
    position: num(saved.position, 0, 0, Number.MAX_SAFE_INTEGER),
    target: num(saved.target, d.target, -30, -5),
    volumeDb: num(saved.volumeDb, d.volumeDb, -60, 6),
    vuReference: num(saved.vuReference, d.vuReference, -24, -6),
  };
}

export function saveSettings(settings: SavedSettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage full or blocked: the session still works, it just won't come back.
  }
}

/** Updates the saved playhead alone, as the page is left. */
export function savePosition(position: number) {
  saveSettings({ ...loadSettings(), position });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const request = action(transaction.objectStore(STORE));
        transaction.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        transaction.onerror = () => {
          db.close();
          reject(transaction.error);
        };
      })
  );
}

/** Keeps the song's original file, not its decoded samples, which are several times larger. */
export function saveSong(file: Blob, name: string) {
  return run("readwrite", (store) => store.put({ file, name }, CURRENT)).then(() => undefined);
}

export async function loadSong(): Promise<{ file: Blob; name: string } | null> {
  try {
    const saved = await run<{ file?: unknown; name?: unknown } | undefined>("readonly", (store) =>
      store.get(CURRENT)
    );
    return saved?.file instanceof Blob && typeof saved.name === "string"
      ? { file: saved.file, name: saved.name }
      : null;
  } catch {
    return null;
  }
}

/** Forgets the song, the settings and the chain: the next load starts fresh. */
export async function clearSession() {
  localStorage.removeItem(SETTINGS_KEY);
  localStorage.removeItem(CHAIN_KEY);
  try {
    await run("readwrite", (store) => store.delete(CURRENT));
  } catch {
    // Nothing saved, or storage blocked.
  }
}
