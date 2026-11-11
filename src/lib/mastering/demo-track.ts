const SAMPLE_RATE = 44_100;
const BPM = 96;
const BARS = 8;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
/** Am, F, C, G: a root in Hz and the chord's notes above it. */
const PROGRESSION = [
  { chord: [220, 261.63, 329.63], root: 55 },
  { chord: [174.61, 220, 261.63], root: 43.65 },
  { chord: [196, 261.63, 329.63], root: 65.41 },
  { chord: [196, 246.94, 293.66], root: 49 },
];

function noiseBuffer(ctx: BaseAudioContext, seconds: number) {
  const buffer = ctx.createBuffer(1, Math.round(seconds * ctx.sampleRate), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index += 1) {
    data[index] = Math.random() * 2 - 1;
  }
  return buffer;
}

function panned(ctx: BaseAudioContext, pan: number, out: AudioNode) {
  const panner = ctx.createStereoPanner();
  panner.pan.value = pan;
  panner.connect(out);
  return panner;
}

function kick(ctx: BaseAudioContext, out: AudioNode, at: number) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(150, at);
  osc.frequency.exponentialRampToValueAtTime(45, at + 0.12);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.9, at + 0.004);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45);
  osc.connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + 0.5);
}

function snare(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, at: number) {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  const band = ctx.createBiquadFilter();
  band.type = "highpass";
  band.frequency.value = 1200;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.45, at + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.22);
  source.connect(band).connect(gain).connect(out);
  const body = ctx.createOscillator();
  const bodyGain = ctx.createGain();
  body.frequency.value = 190;
  bodyGain.gain.setValueAtTime(0.3, at);
  bodyGain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
  body.connect(bodyGain).connect(out);
  source.start(at);
  source.stop(at + 0.25);
  body.start(at);
  body.stop(at + 0.15);
}

function hat(ctx: BaseAudioContext, out: AudioNode, noise: AudioBuffer, at: number, level: number) {
  const source = ctx.createBufferSource();
  source.buffer = noise;
  const high = ctx.createBiquadFilter();
  high.type = "highpass";
  high.frequency.value = 7000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(level, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
  source.connect(high).connect(gain).connect(out);
  source.start(at);
  source.stop(at + 0.06);
}

function bass(ctx: BaseAudioContext, out: AudioNode, hz: number, at: number, length: number) {
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.value = hz;
  const low = ctx.createBiquadFilter();
  low.type = "lowpass";
  low.frequency.value = 420;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.32, at + 0.01);
  gain.gain.setTargetAtTime(0.0001, at + length * 0.8, 0.05);
  osc.connect(low).connect(gain).connect(out);
  osc.start(at);
  osc.stop(at + length + 0.3);
}

function pad(ctx: BaseAudioContext, left: AudioNode, right: AudioNode, notes: number[], at: number, length: number) {
  notes.forEach((hz, index) => {
    for (const [detune, out] of [
      [-7, left],
      [7, right],
    ] as const) {
      const osc = ctx.createOscillator();
      osc.type = index === 0 ? "triangle" : "sawtooth";
      osc.frequency.value = hz;
      osc.detune.value = detune;
      const low = ctx.createBiquadFilter();
      low.type = "lowpass";
      low.frequency.value = 1800;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.linearRampToValueAtTime(0.045, at + 0.4);
      gain.gain.setTargetAtTime(0.0001, at + length - 0.1, 0.15);
      osc.connect(low).connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + length + 1);
    }
  });
}

/**
 * A short stereo song to master, synthesized on the spot: drums, a bass and a
 * wide chord pad over four chords, mixed with headroom and some imbalance
 * left for the chain to fix. Encoded as a 16-bit WAV, as a file would be.
 */
export async function renderDemoSong(): Promise<Blob> {
  const seconds = BARS * BAR + 1;
  const ctx = new OfflineAudioContext(2, Math.round(seconds * SAMPLE_RATE), SAMPLE_RATE);
  const mix = ctx.createGain();
  mix.gain.value = 0.55;
  mix.connect(ctx.destination);
  const noise = noiseBuffer(ctx, 0.3);
  const drums = panned(ctx, 0, mix);
  const hats = panned(ctx, 0.35, mix);
  const low = panned(ctx, 0, mix);
  const padLeft = panned(ctx, -0.8, mix);
  const padRight = panned(ctx, 0.8, mix);

  for (let bar = 0; bar < BARS; bar += 1) {
    const start = bar * BAR;
    const { chord, root } = PROGRESSION[bar % PROGRESSION.length];
    pad(ctx, padLeft, padRight, chord, start, BAR);
    for (let beat = 0; beat < 4; beat += 1) {
      const at = start + beat * BEAT;
      kick(ctx, drums, at);
      if (beat % 2 === 1) {
        snare(ctx, drums, noise, at);
      }
      bass(ctx, low, root * (beat === 3 ? 1.5 : 1), at, BEAT * 0.9);
      for (let eighth = 0; eighth < 2; eighth += 1) {
        hat(ctx, hats, noise, at + (eighth * BEAT) / 2, eighth ? 0.12 : 0.2);
      }
    }
  }

  const rendered = await ctx.startRendering();
  return encodeWav16(rendered);
}

function encodeWav16(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      view.setUint8(offset + index, value.charCodeAt(index));
    }
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * channels * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, channel) => buffer.getChannelData(channel));
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of data) {
      const sample = Math.max(-1, Math.min(1, channel[frame] ?? 0));
      view.setInt16(offset, Math.round(sample * 32_767), true);
      offset += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}
