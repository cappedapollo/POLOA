import { dbToGain } from "@audio-ui/core/analysis";

const RAMP_SECONDS = 0.015;
const METER_FFT = 2048;
const SPECTRUM_FFT = 8192;

/** What the monitors play: the master as it is, or a check of it. */
export type MonitorMode = "stereo" | "mono" | "side" | "left" | "right" | "swap";

/** Each mode as a 2×2 matrix: left out = a·L + b·R, right out = c·L + d·R. */
const MATRIX: Record<MonitorMode, readonly [number, number, number, number]> = {
  left: [1, 0, 1, 0],
  mono: [0.5, 0.5, 0.5, 0.5],
  right: [0, 1, 0, 1],
  side: [0.5, -0.5, 0.5, -0.5],
  stereo: [1, 0, 0, 1],
  swap: [0, 1, 1, 0],
};

/** A stereo tap: an analyser per channel for the meters, and one on both for the spectrum. */
export interface StereoTap {
  channels: readonly [AnalyserNode, AnalyserNode];
  spectrum: AnalyserNode;
}

function stereoTap(ctx: BaseAudioContext, from: AudioNode): StereoTap {
  const splitter = ctx.createChannelSplitter(2);
  from.connect(splitter);
  const channels = [0, 1].map((channel) => {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = METER_FFT;
    splitter.connect(analyser, channel);
    return analyser;
  }) as [AnalyserNode, AnalyserNode];
  const spectrum = ctx.createAnalyser();
  spectrum.fftSize = SPECTRUM_FFT;
  spectrum.smoothingTimeConstant = 0.8;
  from.connect(spectrum);
  return { channels, spectrum };
}

function stereoGain(ctx: BaseAudioContext, gain = 1) {
  const node = ctx.createGain();
  node.channelCount = 2;
  node.channelCountMode = "explicit";
  node.channelInterpretation = "speakers";
  node.gain.value = gain;
  return node;
}

/**
 * The master's signal path around its chain:
 *
 * ```
 * song → trim → pre ─→ [chain] → post → wet ─┐
 *                └→ latency delay → dry ─────┴→ monitor matrix → dim → volume → out
 * ```
 *
 * `pre` and `post` are tapped for the meters, the spectrum and the loudness.
 * The dry path waits as long as the chain does, so A/B switches line up, and
 * can be brought to the master's loudness so the comparison is fair.
 */
export function createMasteringGraph(ctx: AudioContext) {
  const trim = stereoGain(ctx);
  const pre = stereoGain(ctx);
  const post = stereoGain(ctx);
  const wet = stereoGain(ctx, 1);
  const dry = stereoGain(ctx, 0);
  const dryDelay = ctx.createDelay(1);
  const monitorIn = stereoGain(ctx);
  const dim = stereoGain(ctx);
  const volume = stereoGain(ctx);

  trim.connect(pre);
  pre.connect(dryDelay).connect(dry).connect(monitorIn);
  post.connect(wet).connect(monitorIn);

  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  monitorIn.connect(splitter);
  // Index: 0 L→outL, 1 R→outL, 2 L→outR, 3 R→outR.
  const matrix = [0, 1, 2, 3].map((index) => {
    const gain = ctx.createGain();
    gain.gain.value = MATRIX.stereo[index] ?? 0;
    splitter.connect(gain, index % 2);
    gain.connect(merger, 0, index < 2 ? 0 : 1);
    return gain;
  });
  merger.connect(dim).connect(volume).connect(ctx.destination);

  const preTap = stereoTap(ctx, pre);
  const postTap = stereoTap(ctx, post);

  const ramp = (param: AudioParam, value: number) =>
    param.setTargetAtTime(value, ctx.currentTime, RAMP_SECONDS);

  return {
    /** Where the song's player connects. */
    input: trim,
    /** Where the chain takes the sound, and where it gives it back. */
    pre,
    post,
    preTap,
    postTap,
    setInputGain: (db: number) => ramp(trim.gain, dbToGain(db)),
    /** Listens to the master, or to the source through the dry path at `matchDb`. */
    setListen: (source: boolean, matchDb: number) => {
      ramp(wet.gain, source ? 0 : 1);
      ramp(dry.gain, source ? dbToGain(matchDb) : 0);
    },
    setLatency: (seconds: number) => {
      dryDelay.delayTime.setValueAtTime(
        Math.min(1, Math.max(0, seconds)),
        ctx.currentTime
      );
    },
    setMonitor: (mode: MonitorMode) => {
      matrix.forEach((gain, index) => ramp(gain.gain, MATRIX[mode][index] ?? 0));
    },
    setDim: (on: boolean, db = -20) => ramp(dim.gain, on ? dbToGain(db) : 1),
    setVolume: (db: number) =>
      ramp(volume.gain, db <= -60 ? 0 : dbToGain(db)),
    dispose: () => {
      for (const node of [trim, pre, post, wet, dry, dryDelay, monitorIn, splitter, merger, dim, volume, ...matrix]) {
        node.disconnect();
      }
    },
  };
}

export type MasteringGraph = ReturnType<typeof createMasteringGraph>;
