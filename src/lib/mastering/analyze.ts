import { type Loudness, measureLoudness } from "@/lib/loudness";
import { toStereo } from "@/lib/mastering/render";

const FFT_SIZE = 4096;
/** Enough frames to describe a song, few enough to read a long one in about a second. */
const MAX_FRAMES = 1200;
/** Frames quieter than this, in dBFS RMS, are silence and left out of the averages. */
const SILENCE_DB = -60;
const WINDOW_SECONDS = 0.4;

/** Octave bands, by centre frequency. */
export const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16_000] as const;
/** The three bands of the multiband compressor at its default splits. */
export const SPLITS = { high: 3000, low: 200 } as const;

export interface SongAnalysis {
  /** Left louder than right, in dB. */
  balanceDb: number;
  /** -1 to 1 over the whole song: how mono it is. */
  correlation: number;
  duration: number;
  /** The level of each 400 ms window, in dBFS RMS, silence left out, sorted. */
  levels: number[];
  loudness: Loudness;
  /** The multiband bands' levels over time, in dBFS RMS, sorted. */
  bands: { high: number[]; low: number[]; mid: number[] };
  /** Average energy per octave of the mid signal, in dB, at `OCTAVES`. */
  octaves: number[];
  sampleRate: number;
  /** How much the sides carry below 150 Hz, relative to the centre, in dB. */
  sideBassDb: number;
  /** How much the sides carry overall, relative to the centre, in dB. */
  sideDb: number;
}

const db = (power: number) => (power > 0 ? 10 * Math.log10(power) : -200);

/** An in-place radix-2 FFT of `re` + i·`im`. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j] as number, re[i] as number];
      [im[i], im[j]] = [im[j] as number, im[i] as number];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const step = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k += 1) {
        const wr = Math.cos(step * k);
        const wi = Math.sin(step * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = wr * (re[b] as number) - wi * (im[b] as number);
        const ti = wr * (im[b] as number) + wi * (re[b] as number);
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
}

/** The value at `fraction` of a sorted list. */
export function percentile(sorted: readonly number[], fraction: number) {
  if (sorted.length === 0) {
    return -200;
  }
  const at = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[at] as number;
}

/**
 * Reads a song the way a mastering engineer listens to it: how loud, how
 * dynamic, how its energy spreads across the octaves, how wide and how
 * balanced. Runs on the main thread in about a second for a few minutes of
 * stereo.
 */
export function analyzeSong(channels: readonly Float32Array[], sampleRate: number): SongAnalysis {
  const [left, right] = toStereo(channels);
  const frames = left.length;
  const loudness = measureLoudness([left, right], sampleRate);

  // Level, balance and correlation from the samples themselves.
  let ll = 0;
  let rr = 0;
  let lr = 0;
  const windowFrames = Math.round(WINDOW_SECONDS * sampleRate);
  const levels: number[] = [];
  for (let start = 0; start < frames; start += windowFrames) {
    let sum = 0;
    const end = Math.min(frames, start + windowFrames);
    for (let index = start; index < end; index += 1) {
      const l = left[index] as number;
      const r = right[index] as number;
      ll += l * l;
      rr += r * r;
      lr += l * r;
      sum += (l * l + r * r) / 2;
    }
    const level = db(sum / Math.max(1, end - start));
    if (level > SILENCE_DB) {
      levels.push(level);
    }
  }
  levels.sort((a, b) => a - b);

  // The spectrum, frame by frame.
  const window = new Float64Array(FFT_SIZE);
  let windowPower = 0;
  for (let index = 0; index < FFT_SIZE; index += 1) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (FFT_SIZE - 1));
    window[index] = w;
    windowPower += w * w;
  }
  /** Turns a sum of |X|² over bins into a mean square in the time domain. */
  const scale = 2 / (FFT_SIZE * windowPower);
  const binHz = sampleRate / FFT_SIZE;
  const octaveBins = OCTAVES.map((centre) => [
    Math.max(1, Math.floor(centre / Math.SQRT2 / binHz)),
    Math.min(FFT_SIZE / 2, Math.ceil((centre * Math.SQRT2) / binHz)),
  ]);
  const bassBin = Math.round(150 / binHz);
  const lowBin = Math.round(SPLITS.low / binHz);
  const highBin = Math.round(SPLITS.high / binHz);

  const hop = Math.max(FFT_SIZE, Math.floor((frames - FFT_SIZE) / MAX_FRAMES));
  const lRe = new Float64Array(FFT_SIZE);
  const lIm = new Float64Array(FFT_SIZE);
  const rRe = new Float64Array(FFT_SIZE);
  const rIm = new Float64Array(FFT_SIZE);
  const octavePower = new Float64Array(OCTAVES.length);
  let counted = 0;
  let midBass = 0;
  let sideBass = 0;
  let midAll = 0;
  let sideAll = 0;
  const bands = { high: [] as number[], low: [] as number[], mid: [] as number[] };

  for (let start = 0; start + FFT_SIZE <= frames; start += hop) {
    let energy = 0;
    for (let index = 0; index < FFT_SIZE; index += 1) {
      const w = window[index] as number;
      const l = left[start + index] as number;
      const r = right[start + index] as number;
      energy += (l * l + r * r) / 2;
      lRe[index] = l * w;
      rRe[index] = r * w;
    }
    lIm.fill(0);
    rIm.fill(0);
    if (db(energy / FFT_SIZE) < SILENCE_DB) {
      continue;
    }
    fft(lRe, lIm);
    fft(rRe, rIm);
    counted += 1;
    let low = 0;
    let mid = 0;
    let high = 0;
    const mids = new Float64Array(FFT_SIZE / 2 + 1);
    for (let bin = 1; bin <= FFT_SIZE / 2; bin += 1) {
      const mRe = ((lRe[bin] as number) + (rRe[bin] as number)) / 2;
      const mIm = ((lIm[bin] as number) + (rIm[bin] as number)) / 2;
      const sRe = ((lRe[bin] as number) - (rRe[bin] as number)) / 2;
      const sIm = ((lIm[bin] as number) - (rIm[bin] as number)) / 2;
      const m = mRe * mRe + mIm * mIm;
      const s = sRe * sRe + sIm * sIm;
      mids[bin] = m;
      midAll += m;
      sideAll += s;
      if (bin <= bassBin) {
        midBass += m;
        sideBass += s;
      }
      const both = m + s;
      if (bin < lowBin) {
        low += both;
      } else if (bin < highBin) {
        mid += both;
      } else {
        high += both;
      }
    }
    octaveBins.forEach(([from, to], octave) => {
      let sum = 0;
      for (let bin = from as number; bin <= (to as number); bin += 1) {
        sum += mids[bin] as number;
      }
      octavePower[octave] = (octavePower[octave] as number) + sum * scale;
    });
    bands.low.push(db(low * scale));
    bands.mid.push(db(mid * scale));
    bands.high.push(db(high * scale));
  }
  for (const list of Object.values(bands)) {
    list.sort((a, b) => a - b);
  }

  const energy = Math.sqrt(ll * rr);
  return {
    balanceDb: db(ll) - db(rr),
    bands,
    correlation: energy > 0 ? lr / energy : 1,
    duration: frames / sampleRate,
    levels,
    loudness,
    octaves: Array.from(octavePower, (power) => db(power / Math.max(1, counted))),
    sampleRate,
    sideBassDb: db(sideBass) - db(midBass),
    sideDb: db(sideAll) - db(midAll),
  };
}
