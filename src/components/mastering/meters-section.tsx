"use client";

import type { Meter as MeterPrimitive, Source } from "@audio-ui/react";
import { RotateCcwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Lcd } from "@/components/audio-ui/lcd";
import { Led } from "@/components/audio-ui/led";
import { Meter } from "@/components/audio-ui/meter";
import { NeedleMeter } from "@/components/audio-ui/needle-meter";
import { ParameterField } from "@/components/audio-ui/parameter-field";
import { ValueDisplay } from "@/components/audio-ui/value-display";
import {
  deriveSource,
  useChannelSource,
  useSourceValue,
} from "@/components/mastering/sources";
import { Button } from "@/components/ui/button";
import { libraryDevice } from "@/lib/device-library";
import type { LiveLoudness } from "@/lib/loudness";
import type { ChainSlot } from "@/lib/mastering/chain";
import { cn } from "@/lib/utils";

const LEVEL_MARKS = [-48, -24, -12, -6, -3, 0] as const;
const GR_MARKS = [0, 3, 6, 12] as const;
/** A sample this close to full scale counts as a clip. */
const CLIP_DB = -0.1;

const lufs = (value: number) =>
  Number.isFinite(value) ? `${value.toFixed(1)} LUFS` : "-∞ LUFS";

export function Heading({ children }: { children: string }) {
  return (
    <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
      {children}
    </h3>
  );
}

/** A stereo peak/RMS meter with its scale. */
export function StereoMeter({
  label,
  source,
}: {
  label: string;
  source: Source<MeterPrimitive.Root.Frame>;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Meter
        aria-label={label}
        className="h-56"
        clipThreshold={0}
        marks={LEVEL_MARKS}
        max={3}
        min={-60}
        source={source}
        warnThreshold={-6}
      />
      <span className="text-[10px] text-muted-foreground">{label}</span>
    </div>
  );
}

/** How much one dynamics device takes off, as a bar that grows down from 0 dB. */
function ReductionMeter({
  id,
  name,
  reductions,
}: {
  id: string;
  name: string;
  reductions: Source<Readonly<Record<string, number>>>;
}) {
  const source = useMemo(
    () =>
      deriveSource(reductions, (all) => ({
        levels: [Math.abs(all[id] ?? 0)],
      })),
    [id, reductions]
  );
  return (
    <div className="flex flex-col items-center gap-1">
      <Meter
        aria-label={`${name} gain reduction`}
        className="h-56"
        clipThreshold={100}
        marks={GR_MARKS}
        max={18}
        min={0}
        peakMarks="hidden"
        scale="linear"
        size="sm"
        source={source}
        warnThreshold={6}
      />
      <span className="max-w-12 truncate text-[10px] text-muted-foreground">
        {name}
      </span>
    </div>
  );
}

/** Latched clip lights and the loudest sample since the last reset, written outside React. */
export function PeakHold({ source }: { source: Source<MeterPrimitive.Root.Frame> }) {
  const [clipped, setClipped] = useState<[boolean, boolean]>([false, false]);
  const maxRef = useRef(Number.NEGATIVE_INFINITY);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(
    () =>
      source.subscribe(() => {
        const peaks = source.getSnapshot().peaks ?? [];
        const loudest = Math.max(...peaks, Number.NEGATIVE_INFINITY);
        if (loudest > maxRef.current && loudest > -100) {
          maxRef.current = loudest;
          if (textRef.current) {
            textRef.current.textContent = `${loudest.toFixed(1)} dBFS`;
          }
        }
        const overLeft = (peaks[0] ?? -100) >= CLIP_DB;
        const overRight = (peaks[1] ?? -100) >= CLIP_DB;
        if (overLeft || overRight) {
          setClipped((current) =>
            (current[0] || !overLeft) && (current[1] || !overRight)
              ? current
              : [current[0] || overLeft, current[1] || overRight]
          );
        }
      }),
    [source]
  );

  const reset = () => {
    maxRef.current = Number.NEGATIVE_INFINITY;
    if (textRef.current) {
      textRef.current.textContent = "-∞ dBFS";
    }
    setClipped([false, false]);
  };

  return (
    <div className="flex items-center gap-3">
      <Lcd className="flex-1" label="Sample peak (max)" size="sm">
        <span ref={textRef}>-∞ dBFS</span>
      </Lcd>
      <div className="flex flex-col items-center gap-1 text-[10px] text-muted-foreground">
        <div className="flex gap-2">
          <span className="flex items-center gap-1">
            L <Led label="Left clipped" on={clipped[0]} tone="destructive" />
          </span>
          <span className="flex items-center gap-1">
            R <Led label="Right clipped" on={clipped[1]} tone="destructive" />
          </span>
        </div>
        <Button
          aria-label="Reset peak hold and clip lights"
          onClick={reset}
          size="icon-xs"
          variant="ghost"
        >
          <RotateCcwIcon />
        </Button>
      </div>
    </div>
  );
}

/** Phase correlation, -1 (out of phase) to +1 (mono), with the needle written each frame. */
export function CorrelationMeter({ source }: { source: Source<number> }) {
  const markerRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const sync = () => {
      const value = Math.max(-1, Math.min(1, source.getSnapshot()));
      if (markerRef.current) {
        markerRef.current.style.left = `${((value + 1) / 2) * 100}%`;
        markerRef.current.toggleAttribute("data-negative", value < 0);
      }
      if (textRef.current) {
        textRef.current.textContent = `${value >= 0 ? "+" : ""}${value.toFixed(2)}`;
      }
    };
    sync();
    return source.subscribe(sync);
  }, [source]);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>-1</span>
        <span>Correlation</span>
        <span ref={textRef} className="font-mono tabular-nums">
          +1.00
        </span>
        <span>+1</span>
      </div>
      <div
        aria-label="Phase correlation"
        className="relative h-3 rounded-sm bg-[linear-gradient(to_right,var(--destructive)_0%,var(--warning)_45%,var(--success)_60%,var(--success)_100%)] opacity-80"
        role="img"
      >
        <div className="absolute inset-y-0 left-1/2 w-px bg-background/60" />
        <div
          className="absolute -inset-y-0.5 w-1 -translate-x-1/2 rounded-full bg-foreground shadow data-negative:bg-destructive"
          ref={markerRef}
        />
      </div>
    </div>
  );
}

function LoudnessReadout({
  inputLoudness,
  onClear,
  outputLoudness,
  target,
  onTargetChange,
}: {
  inputLoudness: Source<LiveLoudness>;
  onClear: () => void;
  onTargetChange: (value: number) => void;
  outputLoudness: Source<LiveLoudness>;
  target: number;
}) {
  const out = useSourceValue(outputLoudness);
  const input = useSourceValue(inputLoudness);
  const delta = Number.isFinite(out.integrated)
    ? out.integrated - target
    : null;
  const gain =
    Number.isFinite(out.integrated) && Number.isFinite(input.integrated)
      ? out.integrated - input.integrated
      : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-1.5">
        <Lcd label="Momentary" size="sm">
          {lufs(out.momentary)}
        </Lcd>
        <Lcd label="Short-term" size="sm">
          {lufs(out.shortTerm)}
        </Lcd>
        <Lcd label="Integrated" live size="sm">
          {lufs(out.integrated)}
        </Lcd>
      </div>
      <div className="flex items-center gap-2">
        <ParameterField
          className="w-40"
          label="Target"
          max={-5}
          min={-30}
          onValueChange={onTargetChange}
          size="sm"
          step={0.5}
          unit="LUFS"
          value={target}
        />
        <span
          className={cn(
            "font-mono text-xs tabular-nums",
            delta === null
              ? "text-muted-foreground"
              : Math.abs(delta) <= 1
                ? "text-success"
                : delta > 0
                  ? "text-destructive"
                  : "text-warning"
          )}
        >
          {delta === null
            ? "—"
            : `${delta > 0 ? "+" : ""}${delta.toFixed(1)} LU`}
        </span>
        <Button
          aria-label="Restart integrated loudness"
          className="ms-auto"
          onClick={onClear}
          size="icon-xs"
          title="Restart integrated loudness"
          variant="ghost"
        >
          <RotateCcwIcon />
        </Button>
      </div>
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span>Source integrated</span>
        <span className="font-mono tabular-nums">{lufs(input.integrated)}</span>
      </div>
      <div className="flex items-center justify-between text-muted-foreground text-xs">
        <span>Master vs source</span>
        {gain === null ? (
          <span className="font-mono">—</span>
        ) : (
          <ValueDisplay kind="db" label="Loudness gain" size="sm" value={gain} />
        )}
      </div>
    </div>
  );
}

interface MetersSectionProps {
  correlation: Source<number>;
  inputLevels: Source<MeterPrimitive.Root.Frame>;
  inputLoudness: Source<LiveLoudness>;
  onClearLoudness: () => void;
  onTargetChange: (value: number) => void;
  onVuReferenceChange: (value: number) => void;
  outputLevels: Source<MeterPrimitive.Root.Frame>;
  outputLoudness: Source<LiveLoudness>;
  reductions: Source<Readonly<Record<string, number>>>;
  slots: readonly ChainSlot[];
  target: number;
  vuReference: number;
}

/** Devices whose engine reports the gain it takes off. */
const DYNAMICS = new Set([
  "audioui.compressor",
  "audioui.limiter",
  "audioui.multiband",
  "audioui.deesser",
]);

/** Everything the engineer reads: levels, gain reduction, loudness, peaks, phase and VU. */
export function MetersSection({
  correlation,
  inputLevels,
  inputLoudness,
  onClearLoudness,
  onTargetChange,
  onVuReferenceChange,
  outputLevels,
  outputLoudness,
  reductions,
  slots,
  target,
  vuReference,
}: MetersSectionProps) {
  const left = useChannelSource(outputLevels, 0);
  const right = useChannelSource(outputLevels, 1);
  const dynamics = slots.filter((slot) => DYNAMICS.has(slot.device));
  return (
    <aside
      aria-label="Meters"
      className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-3"
    >
      <div className="flex flex-col gap-2">
        <Heading>Levels</Heading>
        <div className="flex items-end gap-3 overflow-x-auto pb-1">
          <StereoMeter label="In" source={inputLevels} />
          <StereoMeter label="Out" source={outputLevels} />
          {dynamics.length > 0 ? (
            <div className="ms-1 flex items-end gap-2 border-s ps-3">
              {dynamics.map((slot) => (
                <ReductionMeter
                  id={slot.id}
                  key={slot.id}
                  name={libraryDevice(slot.device)?.device.name ?? "GR"}
                  reductions={reductions}
                />
              ))}
            </div>
          ) : null}
        </div>
        <PeakHold source={outputLevels} />
      </div>
      <div className="flex flex-col gap-2">
        <Heading>Loudness (BS.1770)</Heading>
        <LoudnessReadout
          inputLoudness={inputLoudness}
          onClear={onClearLoudness}
          onTargetChange={onTargetChange}
          outputLoudness={outputLoudness}
          target={target}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Heading>Stereo</Heading>
        <CorrelationMeter source={correlation} />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Heading>VU</Heading>
          <ParameterField
            className="w-36"
            label="0 VU"
            max={-6}
            min={-24}
            onValueChange={onVuReferenceChange}
            size="sm"
            step={1}
            unit="dBFS"
            value={vuReference}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <NeedleMeter
            aria-label="Left VU"
            className="p-2"
            reference={vuReference}
            source={left}
          />
          <NeedleMeter
            aria-label="Right VU"
            className="p-2"
            reference={vuReference}
            source={right}
          />
        </div>
      </div>
    </aside>
  );
}
