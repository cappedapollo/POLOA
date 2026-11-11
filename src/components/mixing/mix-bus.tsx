"use client"

import { createSource, type Source } from "@audio-ui/react"
import { RotateCcwIcon } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Lcd } from "@/components/audio-ui/lcd"
import { NeedleMeter } from "@/components/audio-ui/needle-meter"
import { SpectrumAnalyzer } from "@/components/audio-ui/spectrum-analyzer"
import {
  CorrelationMeter,
  Heading,
  PeakHold,
  StereoMeter,
} from "@/components/mastering/meters-section"
import {
  useChannelSource,
  useSourceValue,
} from "@/components/mastering/sources"
import { Button } from "@/components/ui/button"
import { useAudioLevels } from "@/hooks/use-audio-levels"
import { useLoudness } from "@/hooks/use-loudness"
import { useSpectrum } from "@/hooks/use-spectrum"
import type { LiveLoudness } from "@/lib/loudness"

const NO_ANALYSERS: readonly AnalyserNode[] = []
/** The VU's 0, in dBFS: a mix sits lower than a master. */
const VU_REFERENCE = -18

const lufs = (value: number) =>
  Number.isFinite(value) ? value.toFixed(1) : "-∞"

/** Phase correlation of two analysers, smoothed, read each frame. */
function useCorrelation(analysers: readonly AnalyserNode[]): Source<number> {
  const [source] = useState(() => createSource(1))
  useEffect(() => {
    const [left, right] = analysers
    if (!(left && right)) {
      return
    }
    const l = new Float32Array(left.fftSize)
    const r = new Float32Array(right.fftSize)
    let shown = 1
    let frame = 0
    const tick = () => {
      left.getFloatTimeDomainData(l)
      right.getFloatTimeDomainData(r)
      let lr = 0
      let ll = 0
      let rr = 0
      for (let index = 0; index < l.length; index += 1) {
        const a = l[index] ?? 0
        const b = r[index] ?? 0
        lr += a * b
        ll += a * a
        rr += b * b
      }
      const energy = Math.sqrt(ll * rr)
      shown += ((energy > 1e-9 ? lr / energy : 1) - shown) * 0.2
      source.set(shown)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [analysers, source])
  return source
}

/**
 * A node owned by the bus, fed from the engine's tap. The engine may
 * disconnect the tap before the meters clean up, so the meters listen here.
 */
function useProbe(tap: AudioNode | null) {
  const probe = useMemo(() => (tap ? tap.context.createGain() : null), [tap])
  useEffect(() => {
    if (!(tap && probe)) {
      return
    }
    tap.connect(probe)
    return () => {
      try {
        tap.disconnect(probe)
      } catch {
        // Already cut by the engine.
      }
    }
  }, [probe, tap])
  return probe
}

/** An analyser hung off a node, for the spectrum: it only listens. */
function useAnalyser(node: AudioNode | null) {
  const analyser = useMemo(() => {
    if (!node) {
      return null
    }
    const made = node.context.createAnalyser()
    made.fftSize = 8192
    made.smoothingTimeConstant = 0.75
    return made
  }, [node])
  useEffect(() => {
    if (!(node && analyser)) {
      return
    }
    node.connect(analyser)
    return () => node.disconnect(analyser)
  }, [analyser, node])
  return analyser
}

function LoudnessLcds({
  onClear,
  source,
}: {
  onClear: () => void
  source: Source<LiveLoudness>
}) {
  const loudness = useSourceValue(source)
  return (
    <div className="flex items-stretch gap-1.5">
      <Lcd className="flex-1" label="Momentary" size="sm">
        {lufs(loudness.momentary)}
      </Lcd>
      <Lcd className="flex-1" label="Short-term" size="sm">
        {lufs(loudness.shortTerm)}
      </Lcd>
      <Lcd className="flex-1" label="Integrated" size="sm">
        {lufs(loudness.integrated)}
      </Lcd>
      <Button
        aria-label="Clear integrated loudness"
        onClick={onClear}
        size="icon-xs"
        variant="ghost"
      >
        <RotateCcwIcon />
      </Button>
    </div>
  )
}

/**
 * The mix bus, as the engine's main channel plays it: its level and peaks,
 * its loudness, its stereo correlation, its spectrum and a VU per side.
 */
export function MixBus({
  analysers,
  tap,
}: {
  analysers: readonly AnalyserNode[] | null
  tap: AudioNode | null
}) {
  const channels = analysers ?? NO_ANALYSERS
  const levels = useAudioLevels(channels)
  const probe = useProbe(tap)
  const loudness = useLoudness(probe)
  const correlation = useCorrelation(channels)
  const spectrum = useSpectrum(useAnalyser(probe))
  const left = useChannelSource(levels, 0)
  const right = useChannelSource(levels, 1)

  return (
    <aside
      aria-label="Mix bus"
      className="flex min-w-0 flex-col gap-4 rounded-xl border bg-card p-3"
    >
      <div className="flex flex-col gap-2">
        <Heading>Mix bus</Heading>
        <div className="flex items-end gap-4">
          <StereoMeter label="Mix" source={levels} />
          <div className="grid flex-1 grid-cols-1 gap-2">
            <NeedleMeter
              aria-label="Left VU"
              className="p-1.5"
              reference={VU_REFERENCE}
              source={left}
            />
            <NeedleMeter
              aria-label="Right VU"
              className="p-1.5"
              reference={VU_REFERENCE}
              source={right}
            />
          </div>
        </div>
        <PeakHold source={levels} />
      </div>
      <div className="flex flex-col gap-2">
        <Heading>Loudness (LUFS)</Heading>
        <LoudnessLcds onClear={loudness.clear} source={loudness.source} />
        <p className="text-[11px] text-muted-foreground">
          Leave the mix some 6 dB of headroom and around -20 to -16 LUFS: the
          mastering desk takes it to the target.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Heading>Stereo</Heading>
        <CorrelationMeter source={correlation} />
      </div>
      <div className="flex flex-col gap-2">
        <Heading>Spectrum</Heading>
        <SpectrumAnalyzer
          aria-label="Mix spectrum"
          className="h-36"
          maxDb={-10}
          minDb={-100}
          source={spectrum}
        />
      </div>
    </aside>
  )
}
