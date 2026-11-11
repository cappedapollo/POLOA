import type { AudioPeaks } from "@audio-ui/core/analysis";
import {
  FileAudioIcon,
  FilePlusIcon,
  Redo2Icon,
  RotateCcwIcon,
  SparklesIcon,
  Undo2Icon,
  UploadIcon,
  WandSparklesIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { AssistantDialog } from "@/components/mastering/assistant-dialog";
import { ChainSection } from "@/components/mastering/chain-section";
import { MetersSection } from "@/components/mastering/meters-section";
import { MonitorSection } from "@/components/mastering/monitor-section";
import { OutputSection } from "@/components/mastering/output-section";
import { SpectrumSection } from "@/components/mastering/spectrum-section";
import { WaveformSection } from "@/components/mastering/waveform-section";
import { Button } from "@/components/ui/button";
import { useMasteringSession } from "@/hooks/use-mastering-session";
import { useUndoHistory } from "@/hooks/use-undo-history";
import type { AnyDeviceState } from "@/lib/device-library";
import type { Loudness } from "@/lib/loudness";
import {
  type ChainSlot,
  createSlot,
  defaultChain,
  sanitizeChain,
} from "@/lib/mastering/chain";
import { renderDemoSong } from "@/lib/mastering/demo-track";
import type { MonitorMode } from "@/lib/mastering/graph";
import {
  clearSession,
  loadSettings,
  loadSong,
  type SavedSettings,
  savePosition,
  saveSettings,
  saveSong,
} from "@/lib/mastering/session-store";

const STORAGE_KEY = "poloa.mastering.chain.v1";
/** A knob drag is one undo step once it has been still this long. */
const COMMIT_MS = 400;

function loadChain(): ChainSlot[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    const chain = saved ? sanitizeChain(JSON.parse(saved)) : null;
    if (chain && chain.length > 0) {
      return chain;
    }
  } catch {
    // A broken save falls back to the default chain.
  }
  return defaultChain();
}

const isEditable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable ||
    target.closest(
      'input, textarea, select, [role="slider"], [role="spinbutton"], [role="combobox"], [role="dialog"]'
    ) !== null);

/** What the rest of the app can ask of the mastering desk. */
export interface MasterStudioHandle {
  /** Loads a song onto the desk and keeps it for the next visit, as a picked file is. */
  load: (file: File) => void;
}

/**
 * The mastering desk: a stereo song through a mastering chain, with its
 * waveform, monitoring, meters and render. The song, the chain and the
 * settings outlive a refresh; a new master clears them.
 */
export function MasterStudio({
  active,
  onNewMaster,
  ref,
}: {
  /** Whether the desk is on screen: hidden, it stops playing and takes no keys or drops. */
  active: boolean;
  /** Called once the saved session is cleared, to start the desk over. */
  onNewMaster: () => void;
  ref?: Ref<MasterStudioHandle>;
}) {
  const [slots, setSlots] = useState<ChainSlot[]>(loadChain);
  const history = useUndoHistory(slots, setSlots);
  const commitTimer = useRef(0);
  const [saved] = useState(loadSettings);
  const [inputGainDb, setInputGainDb] = useState(saved.inputGainDb);
  const [listenSource, setListenSource] = useState(saved.listenSource);
  const [matchLevel, setMatchLevel] = useState(saved.matchLevel);
  const [monitor, setMonitor] = useState<MonitorMode>(saved.monitor);
  const [dim, setDim] = useState(saved.dim);
  const [volumeDb, setVolumeDb] = useState(saved.volumeDb);
  const [loop, setLoop] = useState<{ on: boolean; region: readonly [number, number] }>(saved.loop);
  const [markers, setMarkers] = useState<number[]>(saved.markers);
  const [target, setTarget] = useState(saved.target);
  const [vuReference, setVuReference] = useState(saved.vuReference);
  /** The saved loop and markers, kept for the song that comes back on startup. */
  const [restoring, setRestoring] = useState<SavedSettings | null>(saved);
  const [mastered, setMastered] = useState<{ loudness: Loudness; peaks: AudioPeaks } | null>(
    null
  );
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const session = useMasteringSession({
    dim,
    inputGainDb,
    listenSource,
    loop,
    matchLevel,
    monitor,
    slots,
    volumeDb,
  });
  const { song } = session;

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
  }, [slots]);

  useEffect(() => {
    saveSettings({
      dim,
      inputGainDb,
      listenSource,
      loop,
      markers,
      matchLevel,
      monitor,
      position: session.position.getSnapshot(),
      target,
      volumeDb,
      vuReference,
    });
  }, [dim, inputGainDb, listenSource, loop, markers, matchLevel, monitor, session.position, target, volumeDb, vuReference]);

  // The playhead moves every frame, so it is saved when playback stops and when the page is left.
  const { position } = session;
  useEffect(() => {
    if (!session.playing && session.song) {
      savePosition(position.getSnapshot());
    }
  }, [position, session.playing, session.song]);
  useEffect(() => {
    const save = () => {
      if (session.song) {
        savePosition(position.getSnapshot());
      }
    };
    window.addEventListener("pagehide", save);
    return () => window.removeEventListener("pagehide", save);
  }, [position, session.song]);

  // The last song comes back on startup, decoded again from its original file.
  const { load, seek } = session;
  useEffect(() => {
    let cancelled = false;
    loadSong().then(async (stored) => {
      if (cancelled) {
        return;
      }
      if (!stored) {
        setRestoring(null);
        return;
      }
      await load(stored.file, stored.name);
      if (!cancelled && saved.position > 0) {
        seek(saved.position);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [load, saved.position, seek]);

  // A new song starts with its middle third as the loop, no markers and no rendered master; the restored one keeps its own.
  const [songId, setSongId] = useState<number | null>(null);
  if (song && song.id !== songId) {
    setSongId(song.id);
    const [start, end] = restoring?.loop.region ?? [0, 0];
    if (restoring && end > start && end <= song.duration) {
      setLoop(restoring.loop);
      setMarkers(restoring.markers.filter((time) => time <= song.duration));
    } else {
      setLoop({ on: false, region: [song.duration / 3, (song.duration * 2) / 3] });
      setMarkers([]);
    }
    setRestoring(null);
    setMastered(null);
  }

  // Chain edits: a move, an add or a removal is one step; a knob's drag becomes one when it rests.
  const editChain = useCallback(
    (next: ChainSlot[]) => {
      window.clearTimeout(commitTimer.current);
      history.commit();
      history.edit(next);
    },
    [history]
  );
  const changeSlot = useCallback(
    (id: string, state: AnyDeviceState) => {
      history.change(slots.map((slot) => (slot.id === id ? { ...slot, state } : slot)));
      window.clearTimeout(commitTimer.current);
      commitTimer.current = window.setTimeout(history.commit, COMMIT_MS);
    },
    [history, slots]
  );
  const addDevice = useCallback(
    (device: string, index?: number) => {
      const slot = createSlot(device);
      if (!slot) {
        return;
      }
      const next = [...slots];
      // Picked from the library, a device goes before the limiter, which stays last.
      const limiterAt = next.findIndex((item) => item.device === "audioui.limiter");
      const at = index ?? (limiterAt === -1 ? next.length : limiterAt);
      next.splice(at, 0, slot);
      editChain(next);
    },
    [editChain, slots]
  );
  const moveDevice = useCallback(
    (id: string, index: number) => {
      const from = slots.findIndex((slot) => slot.id === id);
      if (from === -1) {
        return;
      }
      const next = [...slots];
      const [moved] = next.splice(from, 1);
      if (moved) {
        next.splice(index, 0, moved);
      }
      editChain(next);
    },
    [editChain, slots]
  );
  const removeDevice = useCallback(
    (id: string) => editChain(slots.filter((slot) => slot.id !== id)),
    [editChain, slots]
  );
  const resetChain = useCallback(() => editChain(defaultChain()), [editChain]);

  const [assistantRun, setAssistantRun] = useState(0);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const openAssistant = useCallback(() => {
    setAssistantRun((run) => run + 1);
    setAssistantOpen(true);
  }, []);
  const applyAssistant = useCallback(
    (next: ChainSlot[], trim: number) => {
      editChain(next);
      setInputGainDb(trim);
    },
    [editChain]
  );

  const utility = slots.find((slot) => slot.device === "audioui.utility");
  const stereo = useMemo(
    () =>
      utility
        ? { pan: Number(utility.state.pan ?? 0), width: Number(utility.state.width ?? 100) }
        : null,
    [utility]
  );
  const changeStereo = useCallback(
    ({ pan, width }: { pan: number; width: number }) => {
      if (utility) {
        changeSlot(utility.id, { ...utility.state, pan: Math.round(pan), width: Math.round(width) });
      }
    },
    [changeSlot, utility]
  );

  const [saveError, setSaveError] = useState<string | null>(null);
  const loadAndKeep = useCallback(
    (file: Blob, name: string) => {
      setRestoring(null);
      load(file, name);
      setSaveError(null);
      saveSong(file, name).catch(() =>
        setSaveError(`"${name}" is too large to keep in the browser: it won't come back after a refresh.`)
      );
    },
    [load]
  );
  const loadFile = useCallback(
    (file: File | undefined) => {
      if (file) {
        loadAndKeep(file, file.name);
      }
    },
    [loadAndKeep]
  );
  useImperativeHandle(ref, () => ({ load: (file: File) => loadAndKeep(file, file.name) }), [loadAndKeep]);
  const loadDemo = useCallback(async () => {
    loadAndKeep(await renderDemoSong(), "Demo song.wav");
  }, [loadAndKeep]);
  const newMaster = useCallback(async () => {
    if (
      window.confirm(
        "Start a new master? The mastering desk's song, chain and settings will be cleared. Your mix is kept."
      )
    ) {
      await clearSession();
      onNewMaster();
    }
  }, [onNewMaster]);

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    loadFile(event.target.files?.[0]);
    event.target.value = "";
  };

  // A song dropped anywhere on the page, while this desk is on screen, is loaded.
  useEffect(() => {
    if (!active) {
      return;
    }
    const over = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
        setDragging(true);
      }
    };
    const leave = (event: DragEvent) => {
      if (event.relatedTarget === null) {
        setDragging(false);
      }
    };
    const drop = (event: DragEvent) => {
      const file = event.dataTransfer?.files[0];
      if (file) {
        event.preventDefault();
        loadFile(file);
      }
      setDragging(false);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [active, loadFile]);

  const { play, playing } = session;
  useEffect(() => {
    if (!active && playing) {
      play(false);
    }
  }, [active, play, playing]);

  // Space plays, B flips A/B, M checks mono, and the usual keys undo.
  useEffect(() => {
    if (!active) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "z") {
        if (isEditable(event.target)) {
          return;
        }
        event.preventDefault();
        if (event.shiftKey) {
          history.redo();
        } else {
          history.undo();
        }
        return;
      }
      if (mod || event.altKey || isEditable(event.target)) {
        return;
      }
      if (event.code === "Space" && !(event.target instanceof HTMLButtonElement)) {
        if (song) {
          event.preventDefault();
          play(!playing);
        }
      } else if (event.key.toLowerCase() === "b") {
        setListenSource((current) => !current);
      } else if (event.key.toLowerCase() === "m") {
        setMonitor((current) => (current === "mono" ? "stereo" : "mono"));
      } else if (event.key.toLowerCase() === "d") {
        setDim((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, history, play, playing, song]);

  return (
    <div className={active ? "contents" : "hidden"}>
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-2">
        <div className="flex min-w-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs">
          <FileAudioIcon className="size-3.5 text-muted-foreground" />
          <span className="max-w-64 truncate">
            {session.loading ? "Decoding…" : (song?.name ?? "No song loaded")}
          </span>
          {song ? (
            <span className="text-muted-foreground">
              · {song.sampleRate / 1000} kHz · {song.sourceChannels === 1 ? "mono → stereo" : "stereo"}
            </span>
          ) : null}
        </div>
        <input accept="audio/*" className="sr-only" onChange={handleFile} ref={fileInput} type="file" />
        <Button onClick={() => fileInput.current?.click()} size="sm">
          <UploadIcon />
          Load song
        </Button>
        <Button onClick={loadDemo} size="sm" variant="outline">
          <SparklesIcon />
          Demo song
        </Button>
        <Button
          disabled={!song || session.loading}
          onClick={openAssistant}
          size="sm"
          title={song ? "Analyze the song and propose mastering settings" : "Load a song first"}
          variant="secondary"
        >
          <WandSparklesIcon />
          AI mastering
        </Button>
        {song && assistantRun > 0 ? (
          <AssistantDialog
            inputGainDb={inputGainDb}
            key={assistantRun}
            onApply={applyAssistant}
            onOpenChange={setAssistantOpen}
            open={assistantOpen}
            slots={slots}
            song={song}
            target={target}
          />
        ) : null}
        <div className="ms-auto flex items-center gap-1">
          <Button
            aria-label="Undo"
            disabled={!history.canUndo}
            onClick={history.undo}
            size="icon-sm"
            title="Undo (Ctrl+Z)"
            variant="ghost"
          >
            <Undo2Icon />
          </Button>
          <Button
            aria-label="Redo"
            disabled={!history.canRedo}
            onClick={history.redo}
            size="icon-sm"
            title="Redo (Ctrl+Shift+Z)"
            variant="ghost"
          >
            <Redo2Icon />
          </Button>
          <Button onClick={resetChain} size="sm" title="Back to the default mastering chain" variant="ghost">
            <RotateCcwIcon />
            Reset chain
          </Button>
          <Button
            onClick={newMaster}
            size="sm"
            title="Clear the mastering desk: its song, chain and settings"
            variant="ghost"
          >
            <FilePlusIcon />
            New master
          </Button>
        </div>
      </div>

      {session.error ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive text-sm">
          {session.error}
        </p>
      ) : null}
      {saveError ? (
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {saveError}
        </p>
      ) : null}

      <div className="grid min-w-0 gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex min-w-0 flex-col gap-3">
          {song || session.loading ? (
            <WaveformSection
              duration={song?.duration ?? 0}
              key={song?.id ?? "loading"}
              loading={session.loading}
              loop={loop}
              markers={markers}
              masterPeaks={mastered?.peaks ?? null}
              onLoopChange={setLoop}
              onMarkersChange={setMarkers}
              onPlayingChange={play}
              onSeek={session.seek}
              peaks={song?.peaks ?? null}
              playing={playing}
              position={session.position}
            />
          ) : (
            <button
              className="flex h-48 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-card/40 text-muted-foreground text-sm transition-colors hover:bg-muted/40"
              onClick={() => fileInput.current?.click()}
              type="button"
            >
              <UploadIcon className="size-6" />
              <span className="font-medium text-foreground">Drop a stereo mix here, or click to choose a file</span>
              <span>WAV, AIFF, FLAC, MP3, M4A… or try the demo song</span>
            </button>
          )}

          <ChainSection
            inputLevel={session.inputLevel}
            onAdd={addDevice}
            onChange={changeSlot}
            onMove={moveDevice}
            onRemove={removeDevice}
            reductions={session.reductions}
            slots={slots}
            spectrum={session.outputSpectrum}
          />

          <div className="grid min-w-0 gap-3 2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <MonitorSection
              dim={dim}
              inputGainDb={inputGainDb}
              listenSource={listenSource}
              matchDb={session.matchDb}
              matchLevel={matchLevel}
              monitor={monitor}
              onDimChange={setDim}
              onInputGainChange={setInputGainDb}
              onListenSourceChange={setListenSource}
              onMatchLevelChange={setMatchLevel}
              onMonitorChange={setMonitor}
              onStereoChange={changeStereo}
              onVolumeChange={setVolumeDb}
              stereo={stereo}
              volumeDb={volumeDb}
            />
            <SpectrumSection input={session.inputSpectrum} output={session.outputSpectrum} />
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <MetersSection
            correlation={session.correlation}
            inputLevels={session.inputLevels}
            inputLoudness={session.inputLoudness.source}
            onClearLoudness={() => {
              session.inputLoudness.clear();
              session.outputLoudness.clear();
            }}
            onTargetChange={setTarget}
            onVuReferenceChange={setVuReference}
            outputLevels={session.outputLevels}
            outputLoudness={session.outputLoudness.source}
            reductions={session.reductions}
            slots={slots}
            target={target}
            vuReference={vuReference}
          />
          <OutputSection
            inputGainDb={inputGainDb}
            masterLoudness={mastered?.loudness ?? null}
            onMastered={setMastered}
            slots={slots}
            song={song}
            target={target}
          />
          <p className="px-1 text-[11px] text-muted-foreground leading-relaxed">
            <kbd>Space</kbd> play · <kbd>B</kbd> A/B · <kbd>M</kbd> mono · <kbd>D</kbd> dim · <kbd>Ctrl Z</kbd> undo.
            A/B delays the source by the chain's latency and, with Match on, brings it to the master's loudness.
          </p>
        </div>
      </div>

      {active && dragging ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm">
          <div className="rounded-xl border-2 border-primary border-dashed px-10 py-8 font-medium text-lg">
            Drop the song to master it
          </div>
        </div>
      ) : null}
    </div>
  );
}
