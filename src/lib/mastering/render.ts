import { dbToGain } from "@audio-ui/core/analysis";
import { buildChain, type ChainSlot, chainLatency } from "@/lib/mastering/chain";

/** Rendered past the end of the song so a release or a reverb tail is not cut. */
const TAIL_SECONDS = 0.5;

export interface RenderOptions {
  /** The input trim before the chain, in dB. */
  inputGainDb: number;
}

/** Makes sure the song is stereo: a mono file plays in both channels. */
export function toStereo(channels: readonly Float32Array[]): Float32Array[] {
  const left = channels[0] ?? new Float32Array(0);
  return [left, channels[1] ?? left];
}

/**
 * Renders the song through the master chain in an offline context, faster
 * than real time, and gives back its two channels at the song's length:
 * the chain's latency is cut off the start so the master lines up with the
 * source.
 */
export async function renderMaster(
  channels: readonly Float32Array[],
  sampleRate: number,
  slots: readonly ChainSlot[],
  { inputGainDb }: RenderOptions
): Promise<Float32Array[]> {
  const [left, right] = toStereo(channels);
  const frames = left.length;
  const latencyFrames = Math.round(chainLatency(slots, sampleRate) * sampleRate);
  const length = frames + latencyFrames + Math.round(TAIL_SECONDS * sampleRate);
  const ctx = new OfflineAudioContext(2, length, sampleRate);

  const buffer = ctx.createBuffer(2, frames, sampleRate);
  buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const trim = ctx.createGain();
  trim.gain.value = dbToGain(inputGainDb);
  const chain = buildChain(ctx, slots);
  source.connect(trim).connect(chain.input);
  chain.output.connect(ctx.destination);
  await chain.ready;

  source.start(0);
  const rendered = await ctx.startRendering();
  chain.dispose();
  return [0, 1].map((channel) =>
    rendered
      .getChannelData(channel)
      .slice(latencyFrames, latencyFrames + frames)
  );
}
