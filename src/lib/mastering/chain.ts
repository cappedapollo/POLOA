import type { DeviceReadings } from "@audio-ui/core/device";
import type { DeviceBrowserShelf } from "@/components/audio-ui/device-browser";
import {
  type AnyDeviceState,
  DEVICE_LIBRARY,
  type LibraryEngine,
  libraryDevice,
} from "@/lib/device-library";

/** One device on the master chain: its slot id, the device's stable id and its state. */
export interface ChainSlot {
  device: string;
  id: string;
  state: AnyDeviceState;
}

/** An engine as the chain holds it: what the library makes, with the readings a dynamics device reports. */
export type ChainEngine = LibraryEngine & {
  readings?: () => DeviceReadings;
};

/** The shelves a mastering engineer reaches for, in the order of a typical chain. */
const MASTERING_SHELVES = ["Tone", "Dynamics", "Distortion", "Utility", "Space"];

/** The library as the browser lists it, without the instruments. */
export const MASTERING_LIBRARY: readonly DeviceBrowserShelf[] =
  MASTERING_SHELVES.map((label) => ({
    items: DEVICE_LIBRARY.filter((item) => item.shelf === label).map(
      ({ device }) => ({
        description: device.description,
        id: device.id,
        name: device.name,
      })
    ),
    label,
  }));

let slotCount = 0;

/** A new slot for the device `device`, at its defaults with `overrides` on top. */
export function createSlot(
  device: string,
  overrides: Record<string, unknown> = {}
): ChainSlot | null {
  const entry = libraryDevice(device);
  if (!entry) {
    return null;
  }
  slotCount += 1;
  return {
    device,
    id: `${device}-${Date.now().toString(36)}-${slotCount}`,
    state: entry.device.sanitize({ ...entry.device.defaults(), ...overrides }),
  };
}

/**
 * A starting master chain, in signal order: corrective EQ, multiband control,
 * glue compression, a touch of saturation, air, stereo image, trim, and a
 * true-peak limiter last. The colouring stages start switched off.
 */
export function defaultChain(): ChainSlot[] {
  return [
    createSlot("audioui.equalizer"),
    createSlot("audioui.multiband", {
      highThresholdDb: -18,
      lowThresholdDb: -18,
      midThresholdDb: -18,
    }),
    createSlot("audioui.compressor", {
      attackMs: 30,
      kneeDb: 6,
      ratio: 2,
      releaseMs: 200,
      thresholdDb: -16,
    }),
    createSlot("audioui.saturator", { driveDb: 3, enabled: false, mix: 35 }),
    createSlot("audioui.exciter", { amount: 20, enabled: false }),
    createSlot("audioui.mid-side"),
    createSlot("audioui.utility"),
    createSlot("audioui.limiter", {
      ceilingDb: -1.3,
      gainDb: 2,
      truePeak: true,
    }),
  ].filter((slot): slot is ChainSlot => slot !== null);
}

/** Repairs a chain read back from storage: unknown devices dropped, every state sanitized. */
export function sanitizeChain(value: unknown): ChainSlot[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.flatMap((slot) => {
    const entry =
      slot && typeof slot.device === "string"
        ? libraryDevice(slot.device)
        : undefined;
    if (!(entry && typeof slot.id === "string")) {
      return [];
    }
    return [
      {
        device: slot.device as string,
        id: slot.id as string,
        state: entry.device.sanitize(slot.state ?? {}),
      },
    ];
  });
}

/** What the chain delays the sound by, in seconds: the sum of its devices' latencies. */
export function chainLatency(slots: readonly ChainSlot[], sampleRate: number) {
  return slots.reduce((total, slot) => {
    const entry = libraryDevice(slot.device);
    return (
      total +
      (entry
        ? entry.device.latency(
            slot.state as Parameters<typeof entry.device.latency>[0],
            sampleRate
          )
        : 0)
    );
  }, 0);
}

export interface BuiltChain {
  dispose: () => void;
  engines: ReadonlyMap<string, ChainEngine>;
  readonly input: GainNode;
  readonly output: GainNode;
  /** Resolves once every engine that runs a worklet has it in the graph. */
  ready: Promise<void>;
}

/** The engines of `slots` made on `ctx` and wired in series, from `input` to `output`. */
export function buildChain(
  ctx: BaseAudioContext,
  slots: readonly ChainSlot[]
): BuiltChain {
  const input = ctx.createGain();
  const output = ctx.createGain();
  const engines = new Map<string, ChainEngine>();
  let tail: AudioNode = input;
  for (const slot of slots) {
    const entry = libraryDevice(slot.device);
    const engine = entry?.create(ctx, slot.state) as ChainEngine | undefined;
    if (!engine?.input) {
      engine?.dispose();
      continue;
    }
    tail.connect(engine.input);
    tail = engine.output;
    engines.set(slot.id, engine);
  }
  tail.connect(output);
  const ready = Promise.all(
    [...engines.values()].map((engine) => engine.ready ?? true)
  ).then(() => undefined);
  return {
    dispose: () => {
      input.disconnect();
      for (const engine of engines.values()) {
        engine.output.disconnect();
        engine.dispose();
      }
      output.disconnect();
    },
    engines,
    input,
    output,
    ready,
  };
}
