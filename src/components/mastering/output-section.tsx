"use client";

import { type AudioPeaks, computePeaks } from "@audio-ui/core/analysis";
import { DownloadIcon, GaugeIcon, Loader2Icon } from "lucide-react";
import { useCallback, useState } from "react";
import { ExportDialog } from "@/components/audio-ui/export-dialog";
import { Lcd } from "@/components/audio-ui/lcd";
import { Led } from "@/components/audio-ui/led";
import { Button } from "@/components/ui/button";
import { downloadFile } from "@/lib/audio-encode";
import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportSettings,
  exportSound,
} from "@/lib/audio-export";
import { type Loudness, measureLoudness } from "@/lib/loudness";
import type { ChainSlot } from "@/lib/mastering/chain";
import { renderMaster } from "@/lib/mastering/render";
import type { LoadedSong } from "@/hooks/use-mastering-session";
import { cn } from "@/lib/utils";

const PEAK_COUNT = 4096;

const fmt = (value: number, unit: string) =>
  Number.isFinite(value) ? `${value.toFixed(1)} ${unit}` : `-∞ ${unit}`;

type Busy =
  | { stage: "rendering" }
  | { stage: "measuring" }
  | { stage: "encoding"; done: number };

const STAGE_TEXT = {
  encoding: "Encoding",
  measuring: "Measuring loudness",
  rendering: "Rendering the master",
} as const;

function LoudnessCard({
  label,
  loudness,
  target,
}: {
  label: string;
  loudness: Loudness | null;
  target: number;
}) {
  const overs = loudness ? loudness.truePeak > -1 : false;
  const onTarget = loudness ? Math.abs(loudness.lufs - target) <= 1 : false;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground uppercase tracking-wider">
        {label}
        {loudness ? (
          <>
            <span className="ms-auto flex items-center gap-1 normal-case tracking-normal">
              <Led label="On target" on={onTarget} /> target
            </span>
            <span className="flex items-center gap-1 normal-case tracking-normal">
              <Led label="True peak over -1 dBTP" on={overs} tone="destructive" />{" "}
              overs
            </span>
          </>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <Lcd label="Integrated" size="sm">
          {loudness ? fmt(loudness.lufs, "LUFS") : "—"}
        </Lcd>
        <Lcd label="True peak" size="sm">
          {loudness ? fmt(loudness.truePeak, "dBTP") : "—"}
        </Lcd>
        <Lcd label="Sample peak" size="sm">
          {loudness ? fmt(loudness.peak, "dBFS") : "—"}
        </Lcd>
        <Lcd label="PLR" size="sm">
          {loudness && Number.isFinite(loudness.lufs)
            ? `${(loudness.truePeak - loudness.lufs).toFixed(1)} LU`
            : "—"}
        </Lcd>
      </div>
    </div>
  );
}

interface OutputSectionProps {
  inputGainDb: number;
  masterLoudness: Loudness | null;
  onMastered: (result: { loudness: Loudness; peaks: AudioPeaks } | null) => void;
  slots: readonly ChainSlot[];
  song: LoadedSong | null;
  target: number;
}

/**
 * The master as a file: render the whole song through the chain offline to
 * read its integrated loudness and true peak against the source's, then export
 * it as WAV, FLAC or MP3, left as it is or normalized to a loudness target.
 */
export function OutputSection({
  inputGainDb,
  masterLoudness,
  onMastered,
  slots,
  song,
  target,
}: OutputSectionProps) {
  const [busy, setBusy] = useState<Busy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [settings, setSettings] = useState<ExportSettings>(DEFAULT_EXPORT_SETTINGS);
  const [exported, setExported] = useState<string | null>(null);

  const render = useCallback(async () => {
    if (!song) {
      return null;
    }
    setBusy({ stage: "rendering" });
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve)));
    return renderMaster(song.channels, song.sampleRate, slots, { inputGainDb });
  }, [inputGainDb, slots, song]);

  const analyze = useCallback(async () => {
    setError(null);
    try {
      const channels = await render();
      if (!(channels && song)) {
        return;
      }
      setBusy({ stage: "measuring" });
      await new Promise((resolve) => setTimeout(resolve));
      onMastered({
        loudness: measureLoudness(channels, song.sampleRate),
        peaks: computePeaks(channels, PEAK_COUNT),
      });
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "The render failed.");
    } finally {
      setBusy(null);
    }
  }, [onMastered, render, song]);

  const exportMaster = useCallback(
    async (chosen: ExportSettings) => {
      setError(null);
      setExported(null);
      try {
        const channels = await render();
        if (!(channels && song)) {
          return;
        }
        onMastered({
          loudness: measureLoudness(channels, song.sampleRate),
          peaks: computePeaks(channels, PEAK_COUNT),
        });
        const result = await exportSound(
          channels,
          song.sampleRate,
          chosen,
          (stage, done) =>
            setBusy(stage === "encoding" ? { done, stage } : { stage })
        );
        const base = song.name.replace(/\.[^.]+$/, "") || "song";
        const name = `${base} (master).${chosen.format}`;
        downloadFile(result.file, name);
        setExported(
          `${name}: ${fmt(result.loudness.lufs, "LUFS")}, ${fmt(result.loudness.truePeak, "dBTP")}${
            result.gain === 0 ? "" : `, normalized ${result.gain > 0 ? "+" : ""}${result.gain.toFixed(1)} dB`
          }`
        );
      } catch (failed) {
        setError(failed instanceof Error ? failed.message : "The export failed.");
      } finally {
        setBusy(null);
      }
    },
    [onMastered, render, song]
  );

  const duration = song
    ? `${Math.floor(song.duration / 60)}:${String(Math.round(song.duration % 60)).padStart(2, "0")}`
    : "";

  return (
    <section
      aria-label="Master output"
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3"
    >
      <LoudnessCard label="Source file" loudness={song?.loudness ?? null} target={target} />
      <LoudnessCard label="Rendered master" loudness={masterLoudness} target={target} />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!song || busy !== null} onClick={analyze} size="sm" variant="outline">
          <GaugeIcon />
          Analyze master
        </Button>
        <Button
          disabled={!song || busy !== null}
          onClick={() => setDialogOpen(true)}
          size="sm"
        >
          <DownloadIcon />
          Export…
        </Button>
        {busy ? (
          <span aria-live="polite" className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <Loader2Icon className="size-3.5 animate-spin" />
            {STAGE_TEXT[busy.stage]}
            {busy.stage === "encoding" ? ` ${Math.round(busy.done * 100)}%` : "…"}
          </span>
        ) : null}
      </div>
      {exported ? (
        <p className="text-muted-foreground text-xs">Saved {exported}</p>
      ) : null}
      {error ? <p className={cn("text-destructive text-xs")}>{error}</p> : null}
      <ExportDialog
        onExport={exportMaster}
        onOpenChange={setDialogOpen}
        onSettingsChange={setSettings}
        open={dialogOpen}
        range={
          song
            ? `Renders "${song.name}" (${duration}, ${song.sampleRate / 1000} kHz) through the master chain.`
            : undefined
        }
        settings={settings}
      />
    </section>
  );
}
