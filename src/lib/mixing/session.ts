import { computePeaks, normalizePeaks } from "@audio-ui/core/analysis"
import type { Tempo } from "@audio-ui/core/time"
import { channelEqDevice } from "@/components/audio-ui/devices/channel-eq/device"
import { compressorDevice } from "@/components/audio-ui/devices/compressor/device"
import { delayDevice } from "@/components/audio-ui/devices/delay/device"
import { reverbDevice } from "@/components/audio-ui/devices/reverb/device"
import type { Arranged, ArrangementTrack, TrackDevice } from "@/lib/arrangement"
import { type ArrangementDoc, MAIN_TRACK } from "@/lib/arrangement-state"
import type { RecordingSource } from "@/lib/clip-player"
import { DEMO_BPM, type DemoStem } from "@/lib/mastering/demo-track"

export const MIX_TEMPO: Tempo = { beatsPerBar: 4, beatUnit: 4, bpm: DEMO_BPM }
export const REVERB_RETURN = "return-1"
export const DELAY_RETURN = "return-2"
/** Time after the last clip a bounce keeps, for the reverb and delay tails. */
export const TAIL_SECONDS = 2
/** How many slices of a recording are kept for the lanes and the clip panel to draw. */
const RECORDING_PEAKS = 16_384

/** A recording the clips play: its sound, the peaks its clips draw, and how long it lasts. */
export interface Recording {
  length: number
  name: string
  peaks: number[]
  source: Extract<RecordingSource, { channels: readonly Float32Array[] }>
}

const dbGain = (db: number) => 10 ** (db / 20)

const device = <State extends object>(
  id: string,
  described: { defaults: () => State; id: string },
  patch: Partial<State> = {},
  on = true
): TrackDevice => ({
  device: described.id,
  id,
  ...(on ? {} : { on: false }),
  state: { ...described.defaults(), ...patch } as TrackDevice["state"],
})

/** What a new audio track starts with: a channel EQ, flat, and a compressor, switched off until it is wanted. */
export function trackDevices(trackId: string, highPass = false): TrackDevice[] {
  return [
    device(`${trackId}-eq`, channelEqDevice, { highPass }),
    device(
      `${trackId}-comp`,
      compressorDevice,
      { attackMs: 10, ratio: 3, thresholdDb: -20 },
      false
    ),
  ]
}

/** The two return tracks a mix starts with: a plate-like reverb and a dotted-eighth delay. */
export function mixReturns(): ArrangementTrack[] {
  return [
    {
      color: 3,
      devices: [
        device("reverb", reverbDevice, {
          decay: 1.8,
          mix: 100,
          type: "plate" as never,
        }),
      ],
      id: REVERB_RETURN,
      name: "A Reverb",
    },
    {
      color: 4,
      devices: [
        device("delay", delayDevice, {
          division: "1/8d" as never,
          feedback: 30,
          mix: 100,
          sync: true,
        }),
      ],
      id: DELAY_RETURN,
      name: "B Delay",
    },
  ]
}

export function emptyMix(): ArrangementDoc {
  return {
    clips: [],
    duration: 60,
    locators: [],
    loop: { on: false, range: [0, 8] },
    main: MAIN_TRACK,
    returns: mixReturns(),
    signatures: [],
    tempo: MIX_TEMPO,
    tracks: [],
  }
}

/** One amplitude per slice, from 0 to 1, as the lanes and the clip panel draw them. */
function amplitudes(channels: readonly Float32Array[]): number[] {
  const { max, min } = normalizePeaks(computePeaks(channels, RECORDING_PEAKS))
  return Array.from(max, (high, index) => Math.max(high, -(min[index] ?? 0)))
}

export function recordingOf(
  name: string,
  channels: readonly Float32Array[],
  sampleRate: number
): Recording {
  return {
    length: (channels[0]?.length ?? 0) / sampleRate,
    name,
    peaks: amplitudes(channels),
    source: { channels, sampleRate },
  }
}

/** The peaks of a recording over the stretch of it a clip plays. */
export function recordedPeaks(recording: Recording, clip: Arranged): number[] {
  const { length, peaks } = recording
  const from = clip.sourceFrom ?? 0
  const first = Math.max(0, Math.floor((from / length) * peaks.length))
  const last = Math.min(
    peaks.length,
    Math.ceil(((from + clip.sourceLength) / length) * peaks.length)
  )
  return peaks.slice(first, Math.max(first + 1, last))
}

/** A clip that plays a whole recording from `start`, as a stem is laid in. */
export function stemClip(
  id: string,
  name: string,
  track: string,
  length: number,
  start = 0
): Arranged {
  return {
    id,
    name,
    recording: id,
    sourceLength: length,
    track,
    value: { fadeIn: 0, fadeOut: 0, length, offset: 0, start },
  }
}

/** Where the last clip ends: what a bounce renders, before the tail. */
export function mixEnd(doc: ArrangementDoc) {
  return Math.max(
    0,
    ...doc.clips
      .filter((clip) => !clip.disabled)
      .map((clip) => clip.value.start + clip.value.length)
  )
}

/** A rough first balance for the demo's stems: levels, pans and sends a mix might start from. */
const DEMO_MIX: Record<
  string,
  {
    db: number
    delay?: number
    highPass?: boolean
    pan?: number
    reverb?: number
  }
> = {
  Bass: { db: -9 },
  Hats: { db: -16, highPass: true, pan: 0.3 },
  Kick: { db: -8 },
  Lead: { db: -12, delay: 0.25, highPass: true, pan: -0.1, reverb: 0.2 },
  Pad: { db: -14, highPass: true, reverb: 0.3 },
  Snare: { db: -10, highPass: true, reverb: 0.15 },
}

/** The demo's stems as a session: a track each, with its clip, its chain and a first balance. */
export function demoMix(
  stems: readonly DemoStem[],
  sampleRate: number
): { doc: ArrangementDoc; recordings: Map<string, Recording> } {
  const recordings = new Map<string, Recording>()
  const tracks: ArrangementTrack[] = []
  const clips: Arranged[] = []
  stems.forEach((stem, index) => {
    const trackId = `track-${index + 1}`
    const id = `stem-${stem.name.toLowerCase()}`
    const recording = recordingOf(stem.name, stem.channels, sampleRate)
    recordings.set(id, recording)
    const balance = DEMO_MIX[stem.name] ?? { db: 0 }
    const sends: Record<string, number> = {}
    if (balance.reverb) {
      sends[REVERB_RETURN] = balance.reverb
    }
    if (balance.delay) {
      sends[DELAY_RETURN] = balance.delay
    }
    tracks.push({
      color: index,
      devices: trackDevices(trackId, balance.highPass),
      id: trackId,
      kind: "audio",
      mix: {
        color: index,
        gain: dbGain(balance.db),
        muted: false,
        pan: balance.pan ?? 0,
        soloed: false,
      },
      name: stem.name,
      sends,
    })
    clips.push(stemClip(id, stem.name, trackId, recording.length))
  })
  const length = Math.max(
    ...[...recordings.values()].map((recording) => recording.length)
  )
  const bar = (60 / DEMO_BPM) * 4
  return {
    doc: {
      ...emptyMix(),
      clips,
      duration: Math.ceil(length / bar + 1) * bar,
      locators: [
        { at: 0, id: "intro", name: "Band" },
        { at: 4 * bar, id: "lead", name: "Lead in" },
      ],
      tracks,
    },
    recordings,
  }
}

// Persistence: the document in localStorage, the recordings' samples in IndexedDB.

const DOC_KEY = "poloa.mix.doc.v1"
const DB_NAME = "poloa-mixing"
const STORE = "recordings"

interface StoredRecording {
  channels: Float32Array[]
  id: string
  name: string
  sampleRate: number
}

export function loadMixDoc(): ArrangementDoc | null {
  try {
    const raw = localStorage.getItem(DOC_KEY)
    if (!raw) {
      return null
    }
    const doc = JSON.parse(raw) as ArrangementDoc
    return Array.isArray(doc.tracks) &&
      Array.isArray(doc.clips) &&
      doc.main &&
      doc.tempo
      ? doc
      : null
  } catch {
    return null
  }
}

export function saveMixDoc(doc: ArrangementDoc) {
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(doc))
  } catch {
    // Out of room: the mix still plays, it is only not kept.
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1)
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: "id" })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void
) {
  const db = await openDb()
  return new Promise<T | undefined>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode)
    const request = run(transaction.objectStore(STORE))
    transaction.oncomplete = () => {
      db.close()
      resolve(request ? request.result : undefined)
    }
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
  })
}

export async function saveRecordings(
  recordings: ReadonlyMap<string, Recording>
) {
  await withStore("readwrite", (store) => {
    for (const [id, recording] of recordings) {
      const stored: StoredRecording = {
        channels: recording.source.channels.map((channel) => channel.slice()),
        id,
        name: recording.name,
        sampleRate: recording.source.sampleRate,
      }
      store.put(stored)
    }
  })
}

export async function loadRecordings(): Promise<Map<string, Recording>> {
  const stored = ((await withStore("readonly", (store) => store.getAll())) ??
    []) as StoredRecording[]
  return new Map(
    stored.map((item) => [
      item.id,
      recordingOf(item.name, item.channels, item.sampleRate),
    ])
  )
}

/** Drops the recordings no clip plays any more, and everything when `keep` is empty. */
export async function pruneRecordings(keep: ReadonlySet<string>) {
  await withStore("readwrite", (store) => {
    const request = store.getAllKeys()
    request.onsuccess = () => {
      for (const key of request.result) {
        if (!keep.has(String(key))) {
          store.delete(key)
        }
      }
    }
  })
}

export function clearMixDoc() {
  localStorage.removeItem(DOC_KEY)
}
