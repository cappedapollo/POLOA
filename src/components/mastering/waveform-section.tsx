"use client";

import type { AudioPeaks } from "@audio-ui/core/analysis";
import type { Source } from "@audio-ui/react";
import {
  FlagIcon,
  RepeatIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Scrubber } from "@/components/audio-ui/scrubber";
import {
  Timeline,
  TimelineLane,
  TimelineMark,
  TimelineNavigator,
  TimelineRuler,
  TimelineViewport,
} from "@/components/audio-ui/timeline";
import {
  Waveform,
  WaveformHover,
  WaveformMarker,
  WaveformRegion,
  WaveformRegionHandle,
} from "@/components/audio-ui/waveform";
import { Button } from "@/components/ui/button";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const EMPTY: number[] = [];
const MAX_ZOOM = 32;
const ZOOM_STEP = 1.5;
const PAGE_MARGIN = 0.1;
const LABEL_STEPS = [1, 2, 5, 10, 15, 30, 60];
const MIN_LABEL_GAP_PX = 56;
const MAX_MARKERS = 16;

export const formatTime = (seconds: number) => {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${(whole - minutes * 60).toFixed(1).padStart(4, "0")}`;
};

function rulerLabels(duration: number, zoom: number) {
  const step =
    LABEL_STEPS.find((candidate) => candidate * zoom >= MIN_LABEL_GAP_PX) ?? 60;
  const count = duration > 0 ? Math.floor(duration / step) + 1 : 0;
  return Array.from({ length: count }, (_, index) => index * step);
}

interface WaveformSectionProps {
  duration: number;
  loading: boolean;
  loop: { on: boolean; region: readonly [number, number] };
  /** Times marked on the song, in seconds. */
  markers: readonly number[];
  /** The master's shape, once it has been rendered. */
  masterPeaks: AudioPeaks | null;
  onLoopChange: (loop: { on: boolean; region: readonly [number, number] }) => void;
  onMarkersChange: (markers: number[]) => void;
  onPlayingChange: (playing: boolean) => void;
  onSeek: (seconds: number) => void;
  peaks: AudioPeaks | null;
  playing: boolean;
  position: Source<number>;
}

/**
 * The song on a zoomable timeline: seek by pressing or dragging, Shift-drag
 * (or drag the handles) to set the loop you are working on, drop markers on
 * sections, and flip the view to the rendered master to see what the chain
 * did to the shape. Key it by the song, so a new one starts unzoomed.
 */
export function WaveformSection({
  duration,
  loading,
  loop,
  markers,
  masterPeaks,
  onLoopChange,
  onMarkersChange,
  onPlayingChange,
  onSeek,
  peaks,
  playing,
  position,
}: WaveformSectionProps) {
  const [view, setView] = useState<"source" | "master">("source");
  const [zoomPx, setZoomPx] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const frameRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const fitPx = width > 0 && duration > 0 ? width / duration : 0;
  const zoom = Math.max(zoomPx ?? fitPx, fitPx);
  const zoomed = fitPx > 0 && zoom > fitPx * 1.001;
  const ready = peaks !== null && duration > 0;
  const shownView = masterPeaks ? view : "source";
  const shown = shownView === "master" ? masterPeaks : peaks;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    let measure = 0;
    const observer = new ResizeObserver(([entry]) => {
      cancelAnimationFrame(measure);
      const next = entry?.contentRect.width ?? 0;
      // A frame that is momentarily collapsed keeps the last width, so the ruler keeps its labels.
      if (next > 0) {
        measure = requestAnimationFrame(() => setWidth(next));
      }
    });
    observer.observe(frame);
    return () => {
      cancelAnimationFrame(measure);
      observer.disconnect();
    };
  }, []);

  // A zoomed view turns the page as the playhead nears its edge.
  useEffect(() => {
    if (!(playing && zoomed)) {
      return;
    }
    return position.subscribe(() => {
      const viewport = viewportRef.current;
      if (!viewport) {
        return;
      }
      const x = position.getSnapshot() * zoom;
      const margin = viewport.clientWidth * PAGE_MARGIN;
      if (x < viewport.scrollLeft || x > viewport.scrollLeft + viewport.clientWidth - margin) {
        viewport.scrollLeft = Math.max(0, x - margin);
      }
    });
  }, [playing, position, zoom, zoomed]);

  const setRegion = useCallback(
    (region: readonly [number, number]) => onLoopChange({ ...loop, region }),
    [loop, onLoopChange]
  );
  const addMarker = useCallback(() => {
    const time = position.getSnapshot();
    if (markers.length < MAX_MARKERS && !markers.includes(time)) {
      onMarkersChange([...markers, time].sort((a, b) => a - b));
    }
  }, [markers, onMarkersChange, position]);

  return (
    <section
      aria-label="Song"
      className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-3"
    >
      <div ref={frameRef}>
        <Timeline
          disabled={!ready}
          duration={duration || 1}
          maxZoom={Math.max(fitPx * MAX_ZOOM, 1)}
          minZoom={fitPx || 0}
          onPositionChange={onSeek}
          onZoomChange={setZoomPx}
          source={position}
          zoom={fitPx > 0 ? zoom : undefined}
        >
          <TimelineViewport
            className="overflow-y-hidden rounded-lg border"
            ref={viewportRef}
            scrollbar="hidden"
          >
            <TimelineRuler aria-label="Position" getAriaValueText={formatTime}>
              {rulerLabels(duration, zoom).map((seconds) => (
                <TimelineMark key={seconds} value={seconds}>
                  {formatTime(seconds).replace(/\.\d$/, "")}
                </TimelineMark>
              ))}
            </TimelineRuler>
            <TimelineLane className="h-28">
              <Waveform
                aria-label="Song position"
                className="h-28 rounded-none"
                disabled={!ready}
                duration={duration || 1}
                getAriaValueText={formatTime}
                loading={loading || !ready}
                onSelectionChange={setRegion}
                onValueChange={onSeek}
                source={position}
                values={shown ?? EMPTY}
                variant="playhead"
              >
                {ready ? (
                  <WaveformRegion onValueChange={setRegion} value={loop.region}>
                    <WaveformRegionHandle
                      aria-label="Loop start"
                      edge="start"
                      getAriaValueText={formatTime}
                    />
                    <WaveformRegionHandle
                      aria-label="Loop end"
                      edge="end"
                      getAriaValueText={formatTime}
                    />
                  </WaveformRegion>
                ) : null}
                {markers.map((time, index) => (
                  <WaveformMarker key={time} value={time}>
                    {index + 1}
                  </WaveformMarker>
                ))}
                <WaveformHover format={formatTime} />
              </Waveform>
            </TimelineLane>
          </TimelineViewport>
          <TimelineNavigator className="mt-2" getAriaValueText={formatTime} />
        </Timeline>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Scrubber
          className="min-w-64 flex-1"
          duration={duration || 1}
          onPlayingChange={onPlayingChange}
          onSeek={onSeek}
          playing={playing}
          source={position}
        />
        <Toggle
          aria-label="Loop the region"
          disabled={!ready}
          onPressedChange={(on) => onLoopChange({ ...loop, on })}
          pressed={loop.on}
          size="sm"
          variant="outline"
        >
          <RepeatIcon />
          Loop
        </Toggle>
        <Button
          disabled={!ready || markers.length >= MAX_MARKERS}
          onClick={addMarker}
          size="sm"
          variant="outline"
        >
          <FlagIcon />
          Marker
        </Button>
        <div className="flex items-center gap-1 text-muted-foreground text-xs">
          <Button
            aria-label="Zoom out"
            disabled={!(ready && zoomed)}
            onClick={() => setZoomPx(Math.max(fitPx, zoom / ZOOM_STEP))}
            size="icon-sm"
            variant="outline"
          >
            <ZoomOutIcon />
          </Button>
          <span className="min-w-8 text-center tabular-nums">
            {fitPx > 0 ? (zoom / fitPx).toFixed(zoomed ? 1 : 0) : 1}×
          </span>
          <Button
            aria-label="Zoom in"
            disabled={!ready || zoom >= fitPx * MAX_ZOOM * 0.999}
            onClick={() => setZoomPx(Math.min(fitPx * MAX_ZOOM, zoom * ZOOM_STEP))}
            size="icon-sm"
            variant="outline"
          >
            <ZoomInIcon />
          </Button>
        </div>
        <ToggleGroup
          aria-label="Waveform shown"
          onValueChange={(value: string[]) => {
            const next = value[0];
            if (next === "source" || next === "master") {
              setView(next);
            }
          }}
          size="sm"
          spacing={0}
          value={[shownView]}
          variant="outline"
        >
          <ToggleGroupItem value="source">Source</ToggleGroupItem>
          <ToggleGroupItem
            disabled={!masterPeaks}
            title={masterPeaks ? undefined : "Analyze or export the master first"}
            value="master"
          >
            Master
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </section>
  );
}
