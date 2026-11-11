import { type AnyDeviceState, libraryDevice } from "@/lib/device-library";
import { type Loudness, measureLoudness } from "@/lib/loudness";
import { OCTAVES, percentile, type SongAnalysis } from "@/lib/mastering/analyze";
import { type ChainSlot, createSlot } from "@/lib/mastering/chain";
import { renderMaster } from "@/lib/mastering/render";

/**
 * Energy per octave of a balanced modern master, relative to 1 kHz, in dB: a
 * gentle fall of 1.5 dB an octave, with less at the extremes. A reference to
 * steer by, not a target to match.
 */
const REFERENCE = OCTAVES.map((hz) =>
  hz < 50 ? 4.5 : hz > 12_000 ? -9 : -1.5 * Math.log2(hz / 1000)
);
/** How much of a deviation the EQ takes back: half-way keeps the mix's character. */
const EQ_AMOUNT = 0.6;
/** Under the -1 dBTP streaming platforms ask for, with room for the limiter's overshoot. */
const LIMITER_CEILING = -1.5;
const MAX_LIMITER_GAIN = 15;

export interface ParameterChange {
  from: string;
  id: string;
  label: string;
  to: string;
}

/** What the assistant proposes for one device: its new state, what changed and why. */
export interface Suggestion {
  changes: ParameterChange[];
  device: string;
  /** The slot it changes, or the new slot it adds. */
  id: string;
  isNew: boolean;
  name: string;
  reasons: string[];
  state: AnyDeviceState;
}

export interface DiagnosisItem {
  label: string;
  value: string;
  verdict?: "good" | "warn" | "bad";
}

export interface Proposal {
  diagnosis: DiagnosisItem[];
  inputGain: { from: number; reason: string; to: number } | null;
  notes: string[];
  /** The proposed master, rendered and measured with every suggestion applied. */
  predicted: Loudness | null;
  suggestions: Suggestion[];
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const half = (value: number) => Math.round(value * 2) / 2;
const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const signed = (value: number, digits = 1) => `${value > 0 ? "+" : ""}${value.toFixed(digits)}`;

/** A device's new state from `changes`, with what changed listed by label and readout. */
function propose(
  slot: ChainSlot,
  changes: Record<string, unknown>,
  reasons: string[],
  isNew = false
): Suggestion | null {
  const entry = libraryDevice(slot.device);
  if (!entry) {
    return null;
  }
  const { device } = entry;
  const { state } = device.apply(slot.state as Parameters<typeof device.apply>[0], changes);
  const listed: ParameterChange[] = [];
  for (const parameter of device.parameters) {
    const before = slot.state[parameter.id];
    const after = state[parameter.id as keyof typeof state];
    if (before !== after || (isNew && parameter.id in changes)) {
      listed.push({
        from: isNew ? "—" : device.format(parameter.id, before as never),
        id: parameter.id,
        label: parameter.label,
        to: device.format(parameter.id, after as never),
      });
    }
  }
  if (listed.length === 0) {
    return null;
  }
  return {
    changes: listed,
    device: slot.device,
    id: slot.id,
    isNew,
    name: device.name,
    reasons,
    state: state as AnyDeviceState,
  };
}

const first = (slots: readonly ChainSlot[], device: string) =>
  slots.find((slot) => slot.device === `audioui.${device}`);

/** The spectrum against the reference, mids at 0, and its slope in dB an octave from 125 Hz to 8 kHz. */
function tonalBalance(analysis: SongAnalysis) {
  const raw = analysis.octaves.map((level, index) => level - (REFERENCE[index] ?? 0));
  const centre = mean(raw.slice(3, 8));
  const deviation = raw.map((value) => value - centre);
  const xs = OCTAVES.map((hz) => Math.log2(hz / 1000)).slice(2, 9);
  const ys = deviation.slice(2, 9);
  const mx = mean(xs);
  const my = mean(ys);
  const slope =
    xs.reduce((sum, x, index) => sum + (x - mx) * ((ys[index] as number) - my), 0) /
    xs.reduce((sum, x) => sum + (x - mx) ** 2, 0);
  return { deviation, slope };
}

interface SuggestOptions {
  inputGainDb: number;
  target: number;
}

/**
 * The assistant's master for a song: rules a mastering engineer works by,
 * read from the analysis and written as settings for the devices already on
 * the chain (and a limiter, when there is none). Each change says why.
 */
export function suggestMaster(
  analysis: SongAnalysis,
  slots: readonly ChainSlot[],
  { inputGainDb, target }: SuggestOptions
): Proposal {
  const suggestions: Suggestion[] = [];
  const notes: string[] = [];
  const add = (suggestion: Suggestion | null) => suggestion && suggestions.push(suggestion);
  const { loudness } = analysis;
  const plr = loudness.truePeak - loudness.lufs;
  const loudnessRange = percentile(analysis.levels, 0.95) - percentile(analysis.levels, 0.1);

  // Input trim: leave room before the chain so EQ boosts and saturation do not clip.
  let trim = inputGainDb;
  let inputGain: Proposal["inputGain"] = null;
  if (loudness.truePeak + inputGainDb > -3) {
    trim = clamp(half(-4 - loudness.truePeak), -12, 0);
    inputGain = {
      from: inputGainDb,
      reason: `The mix peaks at ${loudness.truePeak.toFixed(1)} dBTP: trim it to leave about 4 dB of headroom into the chain.`,
      to: trim,
    };
  }
  const offset = trim;

  // Tone.
  const { deviation, slope } = tonalBalance(analysis);
  const tilt = first(slots, "tilt-eq");
  let residual = deviation;
  if (tilt && Math.abs(slope) > 0.4) {
    const tiltDb = clamp(half(-slope * 3.3 * EQ_AMOUNT), -3, 3);
    residual = deviation.map((value, index) => value - slope * Math.log2((OCTAVES[index] as number) / 1000));
    add(
      propose(tilt, { enabled: true, pivotHz: 1000, tiltDb }, [
        `The spectrum leans ${signed(slope)} dB an octave against the reference: ${tiltDb > 0 ? "brighten" : "darken"} it around 1 kHz.`,
      ])
    );
  }
  const eq = first(slots, "equalizer");
  if (eq) {
    const reasons: string[] = [];
    const lowDev = mean([residual[1] as number, residual[2] as number]);
    const mudDev = mean([residual[3] as number, residual[4] as number]);
    const harshDev = mean([residual[6] as number, residual[7] as number]);
    const airDev = mean([residual[8] as number, residual[9] as number]);
    const lowDb = Math.abs(lowDev) > 1 ? clamp(half(-lowDev * EQ_AMOUNT), -4, 4) : 0;
    const lowMidDb = mudDev > 1.5 ? -Math.min(3, half(mudDev * EQ_AMOUNT)) : 0;
    const highMidDb =
      harshDev > 1.5
        ? -Math.min(3, half(harshDev * EQ_AMOUNT))
        : harshDev < -2
          ? Math.min(2, half(-harshDev * 0.5))
          : 0;
    const highDb = Math.abs(airDev) > 1 ? clamp(half(-airDev * 0.5), -3, 3) : 0;
    if (lowDb !== 0) {
      reasons.push(`Low end (63–125 Hz) is ${signed(lowDev)} dB off the reference: low shelf ${signed(lowDb)} dB at 100 Hz.`);
    }
    if (lowMidDb !== 0) {
      reasons.push(`Low mids (250–500 Hz) are ${signed(mudDev)} dB heavy, which reads as mud: ${lowMidDb} dB at 300 Hz.`);
    }
    if (highMidDb < 0) {
      reasons.push(`Upper mids (2–4 kHz) are ${signed(harshDev)} dB forward, which tires the ear: ${highMidDb} dB at 3 kHz.`);
    } else if (highMidDb > 0) {
      reasons.push(`Upper mids (2–4 kHz) are ${signed(harshDev)} dB recessed: +${highMidDb} dB at 3 kHz for presence.`);
    }
    if (highDb !== 0) {
      reasons.push(`Air (8–16 kHz) is ${signed(airDev)} dB off the reference: high shelf ${signed(highDb)} dB at 10 kHz.`);
    }
    if (reasons.length === 0) {
      reasons.push("The tonal balance is already close to the reference: the EQ stays flat.");
    }
    add(
      propose(
        eq,
        {
          enabled: true,
          highDb,
          highHz: 10_000,
          highMidDb,
          highMidHz: 3000,
          highMidQ: highMidDb > 0 ? 0.8 : 1,
          highMidType: "peak",
          highQ: Math.SQRT1_2,
          highType: "highshelf",
          lowDb,
          lowHz: 100,
          lowMidDb,
          lowMidHz: 300,
          lowMidQ: 1,
          lowMidType: "peak",
          lowQ: Math.SQRT1_2,
          lowType: "lowshelf",
          outputDb: 0,
        },
        reasons
      )
    );
    if ((deviation[0] as number) > 3 && (deviation[0] as number) > (deviation[1] as number) + 2) {
      notes.push("There is a lot of energy around 30 Hz: check for rumble in the mix, a low cut at 25–30 Hz may help.");
    }
  }
  const exciter = first(slots, "exciter");
  if (exciter && (residual[9] as number) < -3) {
    add(
      propose(exciter, { amount: 15, drive: 30, enabled: true, frequencyHz: 6000 }, [
        `The top octave is ${signed(residual[9] as number)} dB short: a little excitation above 6 kHz adds air without EQ hiss.`,
      ])
    );
  }

  // Dynamics.
  const multiband = first(slots, "multiband");
  if (multiband) {
    const band = (name: "low" | "mid" | "high", label: string) => {
      const levels = analysis.bands[name];
      const swing = percentile(levels, 0.95) - percentile(levels, 0.5);
      const at = (fraction: number, margin: number) =>
        clamp(half(percentile(levels, fraction) + offset + margin), -60, 0);
      const said = `${label} swing ${swing.toFixed(1)} dB between average and loud passages`;
      if (swing > 15) {
        // Sparse hits (hi-hats, kicks): compressing them dulls the mix, so only the loudest are caught.
        return { ratio: 1.5, reason: `${said}: transient, so it is left open.`, threshold: at(0.95, 1) };
      }
      if (swing > 10) {
        return { ratio: 2.2, reason: `${said}: held more firmly.`, threshold: at(0.9, 1) };
      }
      return { ratio: 1.8, reason: `${said}: a light touch.`, threshold: at(0.9, 2) };
    };
    const low = band("low", "Lows");
    const mid = band("mid", "Mids");
    const high = band("high", "Highs");
    add(
      propose(
        multiband,
        {
          attackMs: 20,
          enabled: true,
          highHz: 3000,
          highRatio: high.ratio,
          highThresholdDb: high.threshold,
          lowHz: 200,
          lowRatio: low.ratio,
          lowThresholdDb: low.threshold,
          midRatio: mid.ratio,
          midThresholdDb: mid.threshold,
          outputDb: 0,
          releaseMs: 150,
        },
        [low.reason, mid.reason, high.reason]
      )
    );
  }
  const compressor = first(slots, "compressor");
  if (compressor) {
    if (plr < 9) {
      add(
        propose(compressor, { enabled: false }, [
          `The mix is already dense (peak to loudness ${plr.toFixed(1)} LU): more bus compression would flatten it.`,
        ])
      );
    } else {
      const ratio = plr > 16 ? 2 : plr > 12 ? 1.6 : 1.3;
      const thresholdDb = clamp(half(percentile(analysis.levels, 0.9) + offset - 1), -60, 0);
      add(
        propose(
          compressor,
          {
            attackMs: 30,
            enabled: true,
            kneeDb: 6,
            makeupDb: 0,
            mix: 100,
            ratio,
            releaseMs: loudnessRange > 12 ? 250 : 150,
            thresholdDb,
          },
          [
            `Peak to loudness is ${plr.toFixed(1)} LU: glue at ${ratio}:1, threshold just under the loud passages so it takes 1–2 dB.`,
            "A 30 ms attack lets transients through; the limiter handles the rest.",
          ]
        )
      );
    }
  }

  // Stereo.
  const midSide = first(slots, "mid-side");
  if (midSide && analysis.sideBassDb > -15) {
    add(
      propose(midSide, { bassMonoHz: 120, enabled: true }, [
        `Below 150 Hz the sides are only ${Math.abs(analysis.sideBassDb).toFixed(1)} dB under the centre: keep the bass mono up to 120 Hz for vinyl, clubs and phones.`,
      ])
    );
  }
  const utility = first(slots, "utility");
  if (utility) {
    const changes: Record<string, unknown> = { enabled: true, gainDb: 0 };
    const reasons: string[] = [];
    if (analysis.sideDb < -20) {
      changes.width = 115;
      reasons.push(`The image is narrow (sides ${analysis.sideDb.toFixed(1)} dB under the centre): widen it a little.`);
    } else if (analysis.sideDb > -6) {
      changes.width = 85;
      reasons.push(`The image is very wide (sides ${analysis.sideDb.toFixed(1)} dB under the centre): narrow it a little so it holds up in mono.`);
    }
    if (Math.abs(analysis.balanceDb) > 0.5) {
      const ratio = 10 ** (analysis.balanceDb / 20);
      changes.pan = Math.round(100 * ((4 / Math.PI) * Math.atan(ratio) - 1));
      reasons.push(`The ${analysis.balanceDb > 0 ? "left" : "right"} side is ${Math.abs(analysis.balanceDb).toFixed(1)} dB louder: rebalance toward the centre.`);
    }
    if (reasons.length > 0) {
      add(propose(utility, changes, reasons));
    }
  }
  if (analysis.correlation < 0.2) {
    notes.push(`Correlation is ${analysis.correlation.toFixed(2)}: parts of the mix may cancel in mono. Check with the Mono monitor.`);
  }

  // Loudness: the limiter goes last, with its gain calibrated by a render.
  const existing = first(slots, "limiter");
  const limiterSlot = existing ?? createSlot("audioui.limiter");
  if (limiterSlot) {
    const gainDb = clamp(half(target - (loudness.lufs + offset)), 0, MAX_LIMITER_GAIN);
    add(
      propose(
        limiterSlot,
        { ceilingDb: LIMITER_CEILING, enabled: true, gainDb, releaseMs: 100, truePeak: true },
        [
          `Brings the master to the ${target} LUFS target, peaks held under -1 dBTP so streaming encoders do not clip.`,
        ],
        !existing
      )
    );
  }

  const verdict = (good: boolean, bad: boolean): DiagnosisItem["verdict"] =>
    bad ? "bad" : good ? "good" : "warn";
  const diagnosis: DiagnosisItem[] = [
    { label: "Integrated", value: `${loudness.lufs.toFixed(1)} LUFS` },
    {
      label: "True peak",
      value: `${loudness.truePeak.toFixed(1)} dBTP`,
      verdict: verdict(loudness.truePeak < -1, loudness.truePeak > -0.1),
    },
    { label: "Peak to loudness", value: `${plr.toFixed(1)} LU`, verdict: verdict(plr > 10, plr < 7) },
    { label: "Loudness range", value: `${loudnessRange.toFixed(1)} dB` },
    {
      label: "Tilt",
      value: `${signed(slope)} dB/oct`,
      verdict: verdict(Math.abs(slope) < 0.5, Math.abs(slope) > 1.5),
    },
    {
      label: "Correlation",
      value: analysis.correlation.toFixed(2),
      verdict: verdict(analysis.correlation > 0.3, analysis.correlation < 0),
    },
    {
      label: "Side level",
      value: `${analysis.sideDb.toFixed(1)} dB`,
      verdict: verdict(analysis.sideDb > -20 && analysis.sideDb < -6, analysis.sideDb > -3),
    },
    {
      label: "L/R balance",
      value: `${signed(analysis.balanceDb)} dB`,
      verdict: verdict(Math.abs(analysis.balanceDb) < 0.5, Math.abs(analysis.balanceDb) > 2),
    },
  ];

  return { diagnosis, inputGain, notes, predicted: null, suggestions };
}

/** The chain with `suggestions` applied: changed slots replaced in place, new ones at the end. */
export function applySuggestions(
  slots: readonly ChainSlot[],
  suggestions: readonly Suggestion[]
): ChainSlot[] {
  const byId = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
  const next = slots.map((slot) => {
    const suggestion = byId.get(slot.id);
    return suggestion ? { ...slot, state: suggestion.state } : slot;
  });
  for (const suggestion of suggestions) {
    if (suggestion.isNew) {
      next.push({ device: suggestion.device, id: suggestion.id, state: suggestion.state });
    }
  }
  return next;
}

/**
 * Renders the proposed master offline and corrects the limiter's gain by what
 * the measured loudness misses the target by, then renders again to report
 * what the master will measure.
 */
export async function calibrateProposal(
  proposal: Proposal,
  slots: readonly ChainSlot[],
  song: { channels: readonly Float32Array[]; sampleRate: number },
  target: number,
  onPass?: (pass: number) => void
): Promise<Proposal> {
  const inputGainDb = proposal.inputGain?.to ?? null;
  const limiter = proposal.suggestions.find((suggestion) => suggestion.device === "audioui.limiter");
  const measure = async (suggestions: Suggestion[], trim: number) => {
    const channels = await renderMaster(song.channels, song.sampleRate, applySuggestions(slots, suggestions), {
      inputGainDb: trim,
    });
    return measureLoudness(channels, song.sampleRate);
  };
  const trim = inputGainDb ?? 0;
  onPass?.(1);
  let measured = await measure(proposal.suggestions, trim);
  let suggestions = proposal.suggestions;
  const notes = [...proposal.notes];
  if (limiter && Number.isFinite(measured.lufs) && Math.abs(target - measured.lufs) > 0.3) {
    const wanted = Number(limiter.state.gainDb ?? 0) + (target - measured.lufs);
    const gainDb = clamp(Math.round(wanted * 10) / 10, 0, MAX_LIMITER_GAIN);
    const base = limiter.isNew
      ? createSlot(limiter.device)
      : slots.find((item) => item.id === limiter.id);
    const changes = Object.fromEntries(limiter.changes.map((change) => [change.id, limiter.state[change.id]]));
    const corrected =
      base &&
      propose({ ...base, id: limiter.id }, { ...changes, gainDb }, limiter.reasons, limiter.isNew);
    if (corrected) {
      suggestions = suggestions.map((suggestion) => (suggestion === limiter ? corrected : suggestion));
      onPass?.(2);
      measured = await measure(suggestions, trim);
    }
    if (wanted > MAX_LIMITER_GAIN) {
      notes.push(`Reaching ${target} LUFS needs more than ${MAX_LIMITER_GAIN} dB of limiter drive: the master stops short to keep its punch.`);
    }
  }
  const plr = measured.truePeak - measured.lufs;
  if (Number.isFinite(plr) && plr < 8) {
    notes.push(`The master comes out dense (peak to loudness ${plr.toFixed(1)} LU). Listen for pumping and flattened drums, or settle for a lower target.`);
  }
  return { ...proposal, notes, predicted: measured, suggestions };
}
