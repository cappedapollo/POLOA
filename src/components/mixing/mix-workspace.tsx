"use client"

import { barsBeatsWith, secondsPerBar, type Tempo } from "@audio-ui/core/time"
import { EnvelopeIcon } from "@audio-ui/icons/react"
import {
  ArrowRightLeftIcon,
  AudioLinesIcon,
  DownloadIcon,
  FilePlusIcon,
  Loader2Icon,
  Redo2Icon,
  RotateCcwIcon,
  SlidersHorizontalIcon,
  SparklesIcon,
  Undo2Icon,
  UploadIcon,
  XIcon,
} from "lucide-react"
import {
  type ChangeEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { ArrangementView } from "@/components/audio-ui/arrangement-view"
import { ClipPanel, type ClipSettings } from "@/components/audio-ui/clip-panel"
import { ExportDialog } from "@/components/audio-ui/export-dialog"
import { MixerView } from "@/components/audio-ui/mixer-view"
import { ParameterField } from "@/components/audio-ui/parameter-field"
import { TRACK_COLORS } from "@/components/audio-ui/timeline"
import { Transport } from "@/components/audio-ui/transport"
import { MixBus } from "@/components/mixing/mix-bus"
import { TrackDevices } from "@/components/mixing/track-devices"
import { Button } from "@/components/ui/button"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useArrangement } from "@/hooks/use-arrangement"
import { useArrangementEngine } from "@/hooks/use-arrangement-engine"
import { useTimeSelection } from "@/hooks/use-time-selection"
import { useTimelineCursor } from "@/hooks/use-timeline-cursor"
import { GRID_KEYS, useTimelineGrid } from "@/hooks/use-timeline-grid"
import { useTimelineMarkers } from "@/hooks/use-timeline-markers"
import { useTimelineZoom } from "@/hooks/use-timeline-zoom"
import { useTrackAutomation } from "@/hooks/use-track-automation"
import { type Arranged, NEW_TRACK } from "@/lib/arrangement"
import { renderArrangement } from "@/lib/arrangement-engine"
import {
  type ArrangementCommand,
  type ArrangementDoc,
  trackOf,
} from "@/lib/arrangement-state"
import { decodeAudioChannels } from "@/lib/audio-decode"
import { downloadFile, encodeAudio } from "@/lib/audio-encode"
import {
  DEFAULT_EXPORT_SETTINGS,
  type ExportSettings,
  exportSound,
} from "@/lib/audio-export"
import { libraryDevice } from "@/lib/device-library"
import {
  mixEnd,
  type Recording,
  recordedPeaks,
  recordingOf,
  stemClip,
  TAIL_SECONDS,
  trackDevices,
} from "@/lib/mixing/session"
import { webAudio } from "@/lib/web-audio"

const NO_PEAKS: number[] = []
const NO_READING: readonly {
  at: number
  key: number
  name: string
  track: string
}[] = []
const EXTENSION = /\.[^.]+$/
const PERCENT: Intl.NumberFormatOptions = {
  maximumFractionDigits: 0,
  style: "percent",
}
const ZOOM_STEPPERS = { decrement: "Zoom out", increment: "Zoom in" }
/** A play from this close to the end of the arrangement starts it over, in seconds. */
const END_SLACK = 0.05

type Busy = {
  done: number
  stage: "rendering" | "encoding" | "measuring"
} | null

const formatLength = (seconds: number) => {
  const whole = Math.round(seconds)
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`
}

function typing(target: EventTarget) {
  return (
    (target instanceof HTMLInputElement && target.type !== "range") ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

export interface MixWorkspaceProps {
  /** Whether the mix is on screen: hidden, it stops playing. */
  active: boolean
  initialDoc: ArrangementDoc
  initialRecordings: ReadonlyMap<string, Recording>
  /** The mix, rendered and encoded, for the mastering desk. */
  onBounce: (file: File) => void
  onDocChange: (doc: ArrangementDoc) => void
  onLoadDemo: () => void
  onNewMix: () => void
  onRecordingsAdded: (added: ReadonlyMap<string, Recording>) => void
}

/**
 * The mixing desk: the session's stems on an arrangement (move, trim, fade,
 * split, automate), a console with a channel per track and return and the
 * mix bus, each track's insert chain, and the mix bus's meters. A bounce
 * renders the mix offline and hands it to the mastering desk.
 */
export function MixWorkspace({
  active,
  initialDoc,
  initialRecordings,
  onBounce,
  onDocChange,
  onLoadDemo,
  onNewMix,
  onRecordingsAdded,
}: MixWorkspaceProps) {
  const arrangement = useArrangement({
    colors: TRACK_COLORS.length,
    duration: initialDoc.duration,
    initialClips: initialDoc.clips,
    initialLocators: initialDoc.locators,
    initialLoop: initialDoc.loop,
    initialMain: initialDoc.main,
    initialReturns: initialDoc.returns,
    initialSignatures: initialDoc.signatures,
    initialTracks: initialDoc.tracks,
    tempo: initialDoc.tempo,
  })
  const {
    canRedo,
    canUndo,
    clips,
    copyOf,
    dispatch,
    doc,
    duration,
    loop: { on: looping },
    selectedIds,
    selectedTracks,
    selection,
    signatures,
    tempo,
    tracks,
  } = arrangement

  useEffect(() => onDocChange(doc), [doc, onDocChange])

  // The recordings the clips play.
  const [recordings, setRecordings] =
    useState<ReadonlyMap<string, Recording>>(initialRecordings)
  const sources = useMemo(
    () =>
      new Map([...recordings].map(([id, recording]) => [id, recording.source])),
    [recordings]
  )
  const keepRecordings = useCallback(
    (added: ReadonlyMap<string, Recording>) => {
      setRecordings((current) => new Map([...current, ...added]))
      onRecordingsAdded(added)
    },
    [onRecordingsAdded]
  )

  const automation = useTrackAutomation({ dispatch, tracks })
  const engine = useArrangementEngine({
    doc,
    overridden: automation.overridden,
    recordings: sources,
  })
  const { play, playing, position: clock, stop: stopEngine } = engine
  const getPosition = useCallback(() => clock.getSnapshot(), [clock])
  const playPause = useCallback(() => {
    if (playing) {
      stopEngine()
    } else {
      const from = clock.getSnapshot()
      // The engine stops itself at the end, leaving the playhead there.
      play(from >= duration - END_SLACK ? 0 : from)
    }
  }, [clock, duration, play, playing, stopEngine])
  const seek = useCallback(
    (seconds: number) => (playing ? play(seconds) : clock.set(seconds)),
    [clock, play, playing]
  )
  const stop = useCallback(() => {
    stopEngine()
    clock.set(0)
  }, [clock, stopEngine])
  useEffect(() => {
    if (!active && playing) {
      stopEngine()
    }
  }, [active, playing, stopEngine])

  // Zoom, grid, cursor, locators and the time selection, as the workstation has them.
  const bar = secondsPerBar(tempo)
  const viewportRef = useRef<HTMLDivElement>(null)
  const view = useTimelineZoom({ duration, viewportRef })
  const grid = useTimelineGrid({ tempo, zoom: view.zoom })
  const selectTrack = useCallback(
    (id: string, additive = false) =>
      dispatch({ additive, id, type: "select-track" }),
    [dispatch]
  )
  const timeSelection = useTimeSelection({
    bar,
    clips,
    copyOf,
    dispatch,
    getPosition,
    selectedIds,
    selectedTracks,
    tracks,
  })
  const markers = useTimelineMarkers({
    dispatch,
    getPosition,
    onJump: seek,
    onPlay: (at: number) => play(at),
    step: grid.snapStep,
  })
  const cursorKeys = useTimelineCursor({
    clips,
    duration,
    getPosition,
    locators: doc.locators,
    onAddLocator: markers.addLocator,
    onPickTrack: selectTrack,
    onSeek: seek,
    selectedIds,
    selectedTracks,
    step: grid.step,
    tracks,
  })

  // The track whose devices show: the one picked on its header or its channel, the mix bus by default.
  const [devicesOf, setDevicesOf] = useState<string | null>(null)
  const shownTrack =
    trackOf(doc, devicesOf ?? selectedTracks[0] ?? "") ?? tracks[0] ?? doc.main
  const [bottom, setBottom] = useState<"mixer" | "devices">("mixer")
  const panelRef = useRef<HTMLDivElement>(null)
  const pickTrack = useCallback(
    (id: string) => {
      selectTrack(id)
      setDevicesOf(id)
      panelRef.current?.focus({ preventScroll: true })
    },
    [selectTrack]
  )
  const showDevices = useCallback((id: string) => {
    setDevicesOf(id)
    setBottom("devices")
  }, [])

  // Stems in: a file each, decoded at the engine's rate, on a track of its own with a channel EQ and a compressor, or onto the track it is dropped on.
  const [reading, setReading] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const addFiles = useCallback(
    async (files: File[], trackId: string, at: number) => {
      const ctx = webAudio.getContext()
      if (!ctx || files.length === 0) {
        return
      }
      setError(null)
      setReading(
        files.length === 1 ? (files[0]?.name ?? "") : `${files.length} files`
      )
      try {
        const decoded = await Promise.all(
          files.map((file) =>
            file
              .arrayBuffer()
              .then((bytes) => decodeAudioChannels(ctx, bytes))
              .catch(() => null)
          )
        )
        const own = trackId === NEW_TRACK
        const count = dispatch({ commands: [], type: "batch" }).trackCount
        const commands: ArrangementCommand[] = []
        const added = new Map<string, Recording>()
        let start = own ? 0 : at
        let end = duration
        files.forEach((file, index) => {
          const channels = decoded[index]
          if (!channels?.[0]?.length) {
            return
          }
          const name = file.name.replace(EXTENSION, "") || "Stem"
          const recording = recordingOf(name, channels, ctx.sampleRate)
          const id = `rec-${crypto.randomUUID()}`
          added.set(id, recording)
          let onto = trackId
          if (own) {
            onto = `track-${count + added.size}`
            commands.push({ id: onto, kind: "audio", name, type: "add-track" })
            for (const item of trackDevices(onto, false)) {
              commands.push({
                device: item.device,
                state: item.state,
                track: onto,
                type: "add-device",
              })
            }
          }
          commands.push({
            clip: {
              ...stemClip(id, name, onto, recording.length, start),
              recording: id,
            },
            type: "add-clip",
          })
          end = Math.max(end, start + recording.length + bar)
          start += own ? 0 : recording.length
        })
        if (added.size === 0) {
          setError("None of those files could be read as audio.")
          return
        }
        keepRecordings(added)
        dispatch({
          commands: [
            ...(end > duration
              ? [
                  {
                    duration: Math.ceil(end / bar) * bar,
                    type: "set-duration",
                  } as const,
                ]
              : []),
            ...commands,
          ],
          type: "batch",
        })
      } finally {
        setReading(null)
      }
    },
    [bar, dispatch, duration, keepRecordings]
  )
  const fileInput = useRef<HTMLInputElement>(null)
  const importFiles = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = [...(event.target.files ?? [])]
      event.target.value = ""
      addFiles(files, NEW_TRACK, 0)
    },
    [addFiles]
  )
  // A device dropped from the browser on a track's row goes at the end of its chain; on the add-track row, on a new track.
  const dropDevice = useCallback(
    (device: string, trackId: string) => {
      const entry = libraryDevice(device)
      if (!entry) {
        return
      }
      if (trackId === NEW_TRACK) {
        const next = dispatch({ kind: "audio", type: "add-track" })
        const made = `track-${next.trackCount}`
        dispatch({
          device,
          state: entry.device.defaults(),
          track: made,
          type: "add-device",
        })
        showDevices(made)
        return
      }
      dispatch({
        device,
        state: entry.device.defaults(),
        track: trackId,
        type: "add-device",
      })
      showDevices(trackId)
    },
    [dispatch, showDevices]
  )

  // The clip panel under the tracks, for the first selected clip.
  const [clipViewOpen, setClipViewOpen] = useState(false)
  const [clipBoxesFolded, setClipBoxesFolded] = useState<string[]>([])
  const [clipViewCollapsed, setClipViewCollapsed] = useState(false)
  const peaksOf = useCallback(
    (clip: Arranged) => {
      const recording = clip.recording
        ? recordings.get(clip.recording)
        : undefined
      return recording ? recordedPeaks(recording, clip) : undefined
    },
    [recordings]
  )
  const editedClip = clips.find((clip) => clip.id === selectedIds[0])
  const editedPeaks = useMemo(
    () => (editedClip && peaksOf(editedClip)) ?? NO_PEAKS,
    [editedClip, peaksOf]
  )
  const editClip = useCallback(
    (change: (clip: Arranged) => Arranged) =>
      editedClip && dispatch({ change, id: editedClip.id, type: "edit-clip" }),
    [dispatch, editedClip]
  )
  const settle = useCallback(
    () => dispatch({ type: "settle-clip-edit" }),
    [dispatch]
  )
  const changeClipSettings = useCallback(
    (next: ClipSettings) =>
      editClip((clip) => {
        const length = Math.min(next.length, duration - clip.value.start)
        const fadeIn = Math.min(clip.value.fadeIn, length)
        return {
          ...clip,
          gain: next.gain,
          loop: next.loop ?? undefined,
          reversed: next.reversed,
          transpose: next.transpose,
          value: {
            ...clip.value,
            fadeIn,
            fadeOut: Math.min(clip.value.fadeOut, length - fadeIn),
            length,
            offset: next.offset,
          },
          warp: next.warp ?? undefined,
          warpMode: next.warpMode,
        }
      }),
    [duration, editClip]
  )
  const describe = useCallback(
    (seconds: number) => {
      const { bar: number, beat } = barsBeatsWith(seconds, tempo, signatures)
      return `Bar ${number}, beat ${beat}`
    },
    [signatures, tempo]
  )

  // Out: an export to a file, or a bounce that goes on to mastering.
  const [busy, setBusy] = useState<Busy>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [exportSettings, setExportSettings] = useState<ExportSettings>(
    DEFAULT_EXPORT_SETTINGS
  )
  const [exported, setExported] = useState<string | null>(null)
  const length = mixEnd(doc)
  const end = Math.min(duration, length + TAIL_SECONDS)
  const renderMix = useCallback(async () => {
    const sampleRate = webAudio.getContext()?.sampleRate ?? 48_000
    setBusy({ done: 0, stage: "rendering" })
    const rendered = await renderArrangement(doc, sources, {
      onProgress: (done) => setBusy({ done, stage: "rendering" }),
      sampleRate,
      to: end,
    })
    if (!rendered) {
      throw new Error("This browser cannot render the mix offline.")
    }
    return {
      channels: [rendered.getChannelData(0), rendered.getChannelData(1)],
      sampleRate,
    }
  }, [doc, end, sources])
  const bounce = useCallback(async () => {
    setError(null)
    try {
      const { channels, sampleRate } = await renderMix()
      setBusy({ done: 0, stage: "encoding" })
      const blob = await encodeAudio(channels, {
        bitDepth: 24,
        format: "wav",
        onProgress: (done) => setBusy({ done, stage: "encoding" }),
        sampleRate,
      })
      onBounce(new File([blob], "Mix bounce.wav", { type: "audio/wav" }))
    } catch (failed) {
      setError(failed instanceof Error ? failed.message : "The bounce failed.")
    } finally {
      setBusy(null)
    }
  }, [onBounce, renderMix])
  const exportMix = useCallback(
    async (settings: ExportSettings) => {
      setError(null)
      setExported(null)
      try {
        const { channels, sampleRate } = await renderMix()
        const result = await exportSound(
          channels,
          sampleRate,
          settings,
          (stage, done) =>
            setBusy({
              done,
              stage: stage === "encoding" ? "encoding" : "measuring",
            })
        )
        const name = `Mix.${settings.format}`
        downloadFile(result.file, name)
        setExported(
          `${name}: ${result.loudness.lufs.toFixed(1)} LUFS, ${result.loudness.truePeak.toFixed(1)} dBTP`
        )
      } catch (failed) {
        setError(
          failed instanceof Error ? failed.message : "The export failed."
        )
      } finally {
        setBusy(null)
      }
    },
    [renderMix]
  )

  // The keys, caught on the panel: Space plays, A shows automation, S splits, the rest as the workstation's.
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (typing(event.target)) {
      return
    }
    const key = event.key.toLowerCase()
    const mod = event.metaKey || event.ctrlKey
    if (event.key === "Escape") {
      dispatch({ type: "clear-selection" })
      timeSelection.clear()
      return
    }
    if (mod && (key === "z" || key === "y")) {
      event.preventDefault()
      dispatch({ type: key === "y" || event.shiftKey ? "redo" : "undo" })
      return
    }
    if (mod && GRID_KEYS[event.code] && !event.altKey && !event.shiftKey) {
      event.preventDefault()
      grid.change(GRID_KEYS[event.code])
      return
    }
    if (timeSelection.handleKey(event) || cursorKeys.handleKey(event)) {
      return
    }
    if (key === " " && !mod) {
      event.preventDefault()
      playPause()
      return
    }
    if (key === "a" && !mod && !event.altKey) {
      event.preventDefault()
      automation.toggle()
      return
    }
    if (((key === "s" && !mod) || (key === "e" && mod)) && selection) {
      event.preventDefault()
      dispatch({ at: getPosition(), step: bar / 4, type: "split-cursor" })
      return
    }
    if (event.target === event.currentTarget) {
      cursorKeys.handleArrowKey(event)
    }
  }

  const stage = busy
    ? `${busy.stage === "rendering" ? "Rendering the mix" : busy.stage === "encoding" ? "Encoding" : "Measuring"} ${Math.round(busy.done * 100)}%`
    : null

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the desk's shortcuts, caught from the controls inside it
    <div
      className="flex min-w-0 flex-col gap-3 outline-none"
      onKeyDown={handleKey}
      ref={panelRef}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <div className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
          <AudioLinesIcon className="size-3.5 text-muted-foreground" />
          <span>
            {tracks.length === 0
              ? "No stems loaded"
              : `${tracks.length} ${tracks.length === 1 ? "track" : "tracks"}`}
          </span>
          {length > 0 ? (
            <span className="text-muted-foreground">
              · {formatLength(length)}
            </span>
          ) : null}
        </div>
        <input
          accept="audio/*"
          className="sr-only"
          multiple
          onChange={importFiles}
          ref={fileInput}
          type="file"
        />
        <Button
          disabled={reading !== null}
          onClick={() => fileInput.current?.click()}
          size="sm"
        >
          <UploadIcon />
          Import stems
        </Button>
        <Button onClick={onLoadDemo} size="sm" variant="outline">
          <SparklesIcon />
          Demo stems
        </Button>
        <Button
          disabled={busy !== null || end <= 0}
          onClick={bounce}
          size="sm"
          title={
            end > 0
              ? "Render the mix and open it on the mastering desk"
              : "Import stems first"
          }
          variant="secondary"
        >
          <ArrowRightLeftIcon />
          Bounce to mastering
        </Button>
        <div className="ms-auto flex items-center gap-1">
          <Button
            aria-label="Undo"
            disabled={!canUndo}
            onClick={() => dispatch({ type: "undo" })}
            size="icon-sm"
            title="Undo (Ctrl+Z)"
            variant="ghost"
          >
            <Undo2Icon />
          </Button>
          <Button
            aria-label="Redo"
            disabled={!canRedo}
            onClick={() => dispatch({ type: "redo" })}
            size="icon-sm"
            title="Redo (Ctrl+Y)"
            variant="ghost"
          >
            <Redo2Icon />
          </Button>
          <Button
            disabled={busy !== null || end <= 0}
            onClick={() => setExportOpen(true)}
            size="sm"
            title="Render the mix to a file"
            variant="ghost"
          >
            <DownloadIcon />
            Export mix…
          </Button>
          <Button
            onClick={onNewMix}
            size="sm"
            title="Clear the mixing desk: its tracks and stems"
            variant="ghost"
          >
            <FilePlusIcon />
            New mix
          </Button>
        </div>
      </div>
      <div className="@container/panel flex flex-col gap-3 rounded-xl border bg-card p-3">
        <div className="flex items-center gap-2">
          <Transport
            className="min-w-0 flex-nowrap"
            looping={looping}
            onLoopingChange={(on: boolean) =>
              dispatch({ loop: { on }, type: "set-loop" })
            }
            onPlayPause={playPause}
            onStop={stop}
            onTempoChange={(next: Tempo) =>
              dispatch({ tempo: next, type: "set-tempo" })
            }
            playing={playing}
            signatures={signatures}
            source={clock}
            tempo={tempo}
          />
          <Button
            aria-label="Automation mode"
            aria-pressed={automation.automating}
            onClick={automation.toggle}
            size="icon-sm"
            title="Automation (A)"
            variant={automation.automating ? "default" : "outline"}
          >
            <EnvelopeIcon className="size-4" weight="bold" />
          </Button>
          {automation.anyOverridden ? (
            <Button
              className="text-primary"
              onClick={automation.reenable}
              size="sm"
              variant="outline"
            >
              <RotateCcwIcon />
              Re-enable automation
            </Button>
          ) : null}
          <ParameterField
            className="w-40"
            format={PERCENT}
            hideLabel
            label="Zoom"
            largeStep={1}
            max={view.maxRatio}
            min={1}
            onValueChange={view.setRatio}
            size="sm"
            step={0.25}
            steppers={ZOOM_STEPPERS}
            unit="Zoom"
            value={view.ratio}
          />
        </div>
        {window.isSecureContext ? null : (
          <p className="text-destructive text-xs" role="alert">
            Playback needs a secure page: the browser only runs the mix engine
            on https or localhost. Open this desk at an https:// address, or
            at http://localhost through a tunnel.
          </p>
        )}
        {stage || reading || error || exported ? (
          <p aria-live="polite" className="flex items-center gap-2 text-xs">
            {stage || reading ? (
              <Loader2Icon className="size-3.5 animate-spin text-muted-foreground" />
            ) : null}
            {stage ? (
              <span className="text-muted-foreground">{stage}</span>
            ) : null}
            {reading ? (
              <span className="text-muted-foreground">Reading {reading}…</span>
            ) : null}
            {error ? <span className="text-destructive">{error}</span> : null}
            {exported && !stage ? (
              <span className="text-muted-foreground">Saved {exported}</span>
            ) : null}
          </p>
        ) : null}
        <div className="min-h-64 rounded-lg border overflow-hidden">
          {tracks.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">
              Drop stems here, or use <strong>Import stems</strong> (one WAV per
              instrument, all starting at bar 1), or try the{" "}
              <strong>Demo stems</strong>.
            </p>
          ) : null}
          <ArrangementView
            arrangement={arrangement}
            automation={automation}
            engine={engine}
            findDevice={libraryDevice}
            getCursor={getPosition}
            liveTake={null}
            markers={markers}
            onAddMidiClip={() => undefined}
            onDevice={dropDevice}
            onEditClip={() => setClipViewOpen(true)}
            onFiles={addFiles}
            onSeek={seek}
            onSelectTrack={pickTrack}
            peaksOf={peaksOf}
            reading={NO_READING}
            selectedTrack={selectedTracks[0] ?? null}
            timelineGrid={grid}
            timelineZoom={view}
            timeSelection={timeSelection}
            viewportRef={viewportRef}
          />
        </div>
        {clipViewOpen && editedClip && !editedClip.notes ? (
          <ClipPanel
            active={!editedClip.disabled}
            bar={bar}
            beatsPerBar={tempo.beatsPerBar}
            collapsed={clipViewCollapsed}
            foldedBoxes={clipBoxesFolded}
            format={describe}
            key={editedClip.id}
            name={editedClip.name}
            onActiveChange={(on) => {
              editClip((clip) => ({ ...clip, disabled: !on }))
              settle()
            }}
            onCollapsedChange={setClipViewCollapsed}
            onCrop={() => dispatch({ id: editedClip.id, type: "crop-clip" })}
            onFoldedBoxesChange={setClipBoxesFolded}
            onRename={(name) =>
              dispatch({ id: editedClip.id, name, type: "rename-clip" })
            }
            onValueChange={changeClipSettings}
            onValueCommitted={settle}
            position={clock}
            start={editedClip.value.start}
            value={{
              gain: editedClip.gain ?? 0,
              length: editedClip.value.length,
              loop: editedClip.loop ?? null,
              offset: editedClip.value.offset,
              reversed: Boolean(editedClip.reversed),
              sourceLength: editedClip.sourceLength,
              transpose: editedClip.transpose ?? 0,
              warp: editedClip.warp ?? null,
              warpMode: editedClip.warpMode,
            }}
            values={editedPeaks}
          >
            <Button
              aria-label="Close the clip panel"
              onClick={() => setClipViewOpen(false)}
              size="icon-sm"
              variant="ghost"
            >
              <XIcon />
            </Button>
          </ClipPanel>
        ) : null}
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section
          aria-label="Console"
          className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              aria-label="Console view"
              onValueChange={(value: string[]) => {
                const next = value[0]
                if (next === "mixer" || next === "devices") {
                  setBottom(next)
                }
              }}
              size="sm"
              spacing={0}
              value={[bottom]}
              variant="outline"
            >
              <ToggleGroupItem value="mixer">Mixer</ToggleGroupItem>
              <ToggleGroupItem value="devices">
                <SlidersHorizontalIcon />
                Devices
              </ToggleGroupItem>
            </ToggleGroup>
            {bottom === "devices" ? (
              <ToggleGroup
                aria-label="Devices of"
                className="flex-wrap"
                onValueChange={(value: string[]) =>
                  value[0] && setDevicesOf(value[0])
                }
                size="sm"
                spacing={0}
                value={[shownTrack.id]}
                variant="outline"
              >
                {[...tracks, ...doc.returns, doc.main].map((track) => (
                  <ToggleGroupItem key={track.id} value={track.id}>
                    {track === doc.main ? "Mix bus" : track.name}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            ) : (
              <span className="text-xs text-muted-foreground">
                Click a channel's name to pick it; double-click to open its
                devices.
              </span>
            )}
          </div>
          {bottom === "mixer" ? (
            // biome-ignore lint/a11y/noStaticElementInteractions: a double-click on a channel opens its devices, also reachable from the Devices tab
            <div
              className="h-[26rem] min-w-0 overflow-hidden rounded-lg border"
              onDoubleClick={(event) => {
                const channel = (
                  event.target as HTMLElement
                ).closest<HTMLElement>("[data-mixer-track]")
                const id = channel?.dataset.mixerTrack
                if (id) {
                  showDevices(id)
                }
              }}
            >
              <MixerView
                arrangement={arrangement}
                engine={engine}
                onMix={automation.changeMix}
                onSelectTrack={pickTrack}
                overridden={automation.overridden}
                selectedTrack={devicesOf ?? selectedTracks[0] ?? null}
              />
            </div>
          ) : (
            <TrackDevices
              dispatch={dispatch}
              tempo={tempo}
              track={shownTrack}
            />
          )}
        </section>
        <MixBus
          analysers={engine.meter(doc.main.id)}
          tap={engine.tap(doc.main.id)}
        />
      </div>

      <ExportDialog
        onExport={exportMix}
        onOpenChange={setExportOpen}
        onSettingsChange={setExportSettings}
        open={exportOpen}
        range={`Renders the mix from the start to ${end.toFixed(1)} s, with ${TAIL_SECONDS} s of tail.`}
        settings={exportSettings}
      />
    </div>
  )
}
