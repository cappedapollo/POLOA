"use client";

import type { Source } from "@audio-ui/react";
import { Fader } from "@/components/audio-ui/fader";
import { Knob } from "@/components/audio-ui/knob";
import { Led } from "@/components/audio-ui/led";
import { RockerSwitch } from "@/components/audio-ui/rocker-switch";
import { ValueDisplay } from "@/components/audio-ui/value-display";
import { XYPad } from "@/components/audio-ui/xypad";
import { useSourceValue } from "@/components/mastering/sources";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { MonitorMode } from "@/lib/mastering/graph";

const MONITOR_MODES: { label: string; title: string; value: MonitorMode }[] = [
  { label: "Stereo", title: "Stereo, as mixed", value: "stereo" },
  { label: "Mono", title: "Mono sum: (L + R) / 2", value: "mono" },
  { label: "Side", title: "Side only: (L − R) / 2", value: "side" },
  { label: "L", title: "Left channel in both speakers", value: "left" },
  { label: "R", title: "Right channel in both speakers", value: "right" },
  { label: "Swap", title: "Left and right swapped", value: "swap" },
];

const formatDb = (db: number) =>
  db <= -60 ? "-∞ dB" : `${db > 0 ? "+" : ""}${db.toFixed(1)} dB`;

function Caption({ children }: { children: string }) {
  return (
    <span className="text-[10px] text-muted-foreground uppercase tracking-wider">
      {children}
    </span>
  );
}

function MatchReadout({ source }: { source: Source<number> }) {
  const value = useSourceValue(source);
  return <ValueDisplay kind="db" label="Match gain" size="sm" value={value} />;
}

interface MonitorSectionProps {
  dim: boolean;
  inputGainDb: number;
  listenSource: boolean;
  matchDb: Source<number>;
  matchLevel: boolean;
  monitor: MonitorMode;
  onDimChange: (on: boolean) => void;
  onInputGainChange: (db: number) => void;
  onListenSourceChange: (source: boolean) => void;
  onMatchLevelChange: (on: boolean) => void;
  onMonitorChange: (mode: MonitorMode) => void;
  onStereoChange: (value: { pan: number; width: number }) => void;
  onVolumeChange: (db: number) => void;
  /** The stereo field of the chain's Utility, or null without one. */
  stereo: { pan: number; width: number } | null;
  volumeDb: number;
}

/**
 * The monitor controller: what the engineer hears and how. A/B between source
 * and master, with the source brought to the master's loudness so louder never
 * passes for better; mono, side and single-channel checks; dim and the
 * listening level. Next to it, the input trim into the chain and the stereo
 * field of the chain's Utility on one pad.
 */
export function MonitorSection({
  dim,
  inputGainDb,
  listenSource,
  matchDb,
  matchLevel,
  monitor,
  onDimChange,
  onInputGainChange,
  onListenSourceChange,
  onMatchLevelChange,
  onMonitorChange,
  onStereoChange,
  onVolumeChange,
  stereo,
  volumeDb,
}: MonitorSectionProps) {
  return (
    <section
      aria-label="Monitoring"
      className="flex min-w-0 flex-wrap items-stretch gap-4 rounded-xl border bg-card p-3"
    >
      <div className="flex flex-col items-center gap-2">
        <Caption>Input</Caption>
        <Knob
          aria-label="Input trim"
          anchor={0}
          defaultValue={0}
          formatValue={formatDb}
          max={24}
          min={-24}
          onValueChange={onInputGainChange}
          size="lg"
          step={0.1}
          value={inputGainDb}
          valueLabel="always"
        />
      </div>

      <div className="flex flex-col gap-3 border-s ps-4">
        <div className="flex items-start gap-4">
          <div className="flex flex-col items-center gap-1">
            <Caption>A / B</Caption>
            <RockerSwitch
              aria-label="Listen to the master (B) or the source (A)"
              checked={!listenSource}
              offLabel="A"
              onCheckedChange={(master) => onListenSourceChange(!master)}
              onLabel="B"
            />
            <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Led label="Listening to source" on={listenSource} />
              {listenSource ? "Source" : "Master"}
            </div>
          </div>
          <div className="flex flex-col items-center gap-1">
            <Caption>Match</Caption>
            <RockerSwitch
              aria-label="Match the source's loudness to the master"
              checked={matchLevel}
              onCheckedChange={onMatchLevelChange}
            />
            <MatchReadout source={matchDb} />
          </div>
          <div className="flex flex-col items-center gap-1">
            <Caption>Dim</Caption>
            <RockerSwitch
              aria-label="Dim the monitors by 20 dB"
              checked={dim}
              onCheckedChange={onDimChange}
            />
            <Led label="Dim" on={dim} tone="destructive" />
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <Caption>Monitor</Caption>
          <ToggleGroup
            aria-label="Monitor mode"
            onValueChange={(value: string[]) => {
              const next = value[0] as MonitorMode | undefined;
              if (next) {
                onMonitorChange(next);
              }
            }}
            size="sm"
            spacing={0}
            value={[monitor]}
            variant="outline"
          >
            {MONITOR_MODES.map((mode) => (
              <ToggleGroupItem
                aria-label={mode.title}
                key={mode.value}
                title={mode.title}
                value={mode.value}
              >
                {mode.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>
      </div>

      <div className="flex flex-col items-center gap-1 border-s ps-4">
        <Caption>Volume</Caption>
        <Fader
          aria-label="Monitor volume"
          className="h-36 [--fader-min-height:8rem]"
          defaultValue={-6}
          formatValue={formatDb}
          marks={[6, 0, -12, -24, -48]}
          max={6}
          min={-60}
          onValueChange={onVolumeChange}
          size="sm"
          step={0.5}
          value={volumeDb}
        />
      </div>

      <div className="flex min-w-48 flex-1 flex-col gap-1 border-s ps-4">
        <Caption>Stereo field (Utility)</Caption>
        <XYPad
          aria-label="Stereo field: balance across, width up"
          disabled={!stereo}
          formatValue={({ x, y }) =>
            `${x === 0 ? "C" : `${x < 0 ? "L" : "R"} ${Math.abs(Math.round(x))}`} · ${Math.round(y)}% wide`
          }
          maxX={100}
          maxY={200}
          minX={-100}
          minY={0}
          onValueChange={({ x, y }) => onStereoChange({ pan: x, width: y })}
          size="sm"
          value={{ x: stereo?.pan ?? 0, y: stereo?.width ?? 100 }}
        />
        {stereo ? null : (
          <span className="text-[10px] text-muted-foreground">
            Add a Utility to the chain to use the pad.
          </span>
        )}
      </div>
    </section>
  );
}
