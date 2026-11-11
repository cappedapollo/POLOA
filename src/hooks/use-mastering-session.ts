"use client";

import { type AudioPeaks, computePeaks } from "@audio-ui/core/analysis";
import { createSource, type Source } from "@audio-ui/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAudioLevels } from "@/hooks/use-audio-levels";
import { useLoudness } from "@/hooks/use-loudness";
import { useSpectrum } from "@/hooks/use-spectrum";
import { decodeAudioChannels } from "@/lib/audio-decode";
import { type Loudness, measureLoudness } from "@/lib/loudness";
import {
  type BuiltChain,
  buildChain,
  type ChainSlot,
  chainLatency,
} from "@/lib/mastering/chain";
import {
  createMasteringGraph,
  type MasteringGraph,
  type MonitorMode,
} from "@/lib/mastering/graph";
import { toStereo } from "@/lib/mastering/render";
import { webAudio } from "@/lib/web-audio";

const PEAK_COUNT = 4096;
const SPECTRUM_RANGE = { maxHz: 20_000, minHz: 20 };
/** The most the source is brought up or down to match the master's loudness. */
const MAX_MATCH_DB = 24;

export interface LoadedSong {
  channels: Float32Array[];
  /** Tells one load from the next, even of the same file. */
  id: number;
  duration: number;
  name: string;
  /** The source as measured over the whole file, once it is decoded. */
  loudness: Loudness | null;
  peaks: AudioPeaks;
  sampleRate: number;
  /** How many channels the file had before it was made stereo. */
  sourceChannels: number;
}

export interface MasteringOptions {
  dim: boolean;
  inputGainDb: number;
  /** Listen to the source instead of the master (the "A" of an A/B). */
  listenSource: boolean;
  loop: { on: boolean; region: readonly [number, number] };
  /** Brings the source to the master's loudness while it is listened to. */
  matchLevel: boolean;
  monitor: MonitorMode;
  slots: readonly ChainSlot[];
  volumeDb: number;
}

const finite = (value: number) => (Number.isFinite(value) ? value : null);

/**
 * A song played through a master chain on the page's audio context, with
 * everything a mastering desk reads from it: levels in and out, spectra,
 * loudness, stereo correlation and each dynamics device's gain reduction.
 * Live readings are sources, so the meters move without React rendering.
 */
export function useMasteringSession(options: MasteringOptions) {
  const [graph, setGraph] = useState<MasteringGraph | null>(null);
  const [song, setSong] = useState<LoadedSong | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position] = useState(() => createSource(0));
  const [correlation] = useState(() => createSource(1));
  const [reductions] = useState(() =>
    createSource<Readonly<Record<string, number>>>({})
  );
  const [matchDb] = useState(() => createSource(0));

  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });
  const chainRef = useRef<BuiltChain | null>(null);
  const appliedStates = useRef(new Map<string, ChainSlot["state"]>());
  const bufferRef = useRef<AudioBuffer | null>(null);
  const loadCount = useRef(0);
  const player = useRef<{
    node: AudioBufferSourceNode;
    offset: number;
    startedAt: number;
  } | null>(null);

  // The graph lives as long as the page.
  useEffect(() => {
    const ctx = webAudio.getContext();
    if (!ctx) {
      return;
    }
    const made = createMasteringGraph(ctx);
    // The graph is made here, not in a state initializer, so Strict Mode's remount disposes and remakes it in step.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setGraph(made);
    return () => {
      made.dispose();
      setGraph(null);
    };
  }, []);

  // The chain is rebuilt when its devices or their order change; a knob only updates its engine.
  const structure = options.slots.map((slot) => slot.id).join("|");
  useEffect(() => {
    if (!graph) {
      return;
    }
    const ctx = graph.pre.context;
    const slots = optionsRef.current.slots;
    const chain = buildChain(ctx, slots);
    graph.pre.connect(chain.input);
    chain.output.connect(graph.post);
    chainRef.current = chain;
    appliedStates.current = new Map(slots.map((slot) => [slot.id, slot.state]));
    graph.setLatency(chainLatency(slots, ctx.sampleRate));
    return () => {
      try {
        graph.pre.disconnect(chain.input);
      } catch {
        // The graph was disposed first, as the session unmounts.
      }
      chain.dispose();
      chainRef.current = null;
    };
  }, [graph, structure]);

  useEffect(() => {
    const chain = chainRef.current;
    if (!(chain && graph)) {
      return;
    }
    for (const slot of options.slots) {
      if (appliedStates.current.get(slot.id) !== slot.state) {
        chain.engines.get(slot.id)?.update(slot.state);
        appliedStates.current.set(slot.id, slot.state);
      }
    }
    graph.setLatency(chainLatency(options.slots, graph.pre.context.sampleRate));
  }, [graph, options.slots]);

  useEffect(() => {
    graph?.setInputGain(options.inputGainDb);
  }, [graph, options.inputGainDb]);
  useEffect(() => {
    graph?.setMonitor(options.monitor);
  }, [graph, options.monitor]);
  useEffect(() => {
    graph?.setDim(options.dim);
  }, [graph, options.dim]);
  useEffect(() => {
    graph?.setVolume(options.volumeDb);
  }, [graph, options.volumeDb]);

  // Meters, spectra and loudness, in and out.
  const preAnalysers = useMemo(
    () => (graph ? graph.preTap.channels : []),
    [graph]
  );
  const postAnalysers = useMemo(
    () => (graph ? graph.postTap.channels : []),
    [graph]
  );
  const inputLevels = useAudioLevels(preAnalysers);
  const outputLevels = useAudioLevels(postAnalysers);
  const inputSpectrum = useSpectrum(
    graph?.preTap.spectrum ?? null,
    SPECTRUM_RANGE
  );
  const outputSpectrum = useSpectrum(
    graph?.postTap.spectrum ?? null,
    SPECTRUM_RANGE
  );
  const inputLoudness = useLoudness(graph?.pre ?? null);
  const outputLoudness = useLoudness(graph?.post ?? null);
  const { clear: clearInputLoudness } = inputLoudness;
  const { clear: clearOutputLoudness } = outputLoudness;

  /** The loudest channel going in, in dB: the dot a compressor's curve carries. */
  const inputLevel = useMemo<Source<number>>(
    () => ({
      getSnapshot: () => Math.max(...inputLevels.getSnapshot().levels, -100),
      subscribe: inputLevels.subscribe,
    }),
    [inputLevels]
  );

  // The gain that brings the source to the master's loudness, followed as both are measured.
  useEffect(() => {
    if (!graph) {
      return;
    }
    const apply = () => {
      const pre = inputLoudness.source.getSnapshot();
      const post = outputLoudness.source.getSnapshot();
      const diff =
        finite(post.integrated) !== null && finite(pre.integrated) !== null
          ? post.integrated - pre.integrated
          : finite(post.shortTerm) !== null && finite(pre.shortTerm) !== null
            ? post.shortTerm - pre.shortTerm
            : 0;
      const clamped = Math.max(-MAX_MATCH_DB, Math.min(MAX_MATCH_DB, diff));
      matchDb.set(clamped);
      const { listenSource, matchLevel } = optionsRef.current;
      graph.setListen(listenSource, matchLevel ? clamped : 0);
    };
    apply();
    const offPre = inputLoudness.source.subscribe(apply);
    const offPost = outputLoudness.source.subscribe(apply);
    return () => {
      offPre();
      offPost();
    };
  }, [
    graph,
    inputLoudness.source,
    matchDb,
    outputLoudness.source,
    options.listenSource,
    options.matchLevel,
  ]);

  // Correlation and gain reduction, read each frame.
  useEffect(() => {
    if (!graph) {
      return;
    }
    const [left, right] = graph.postTap.channels;
    const l = new Float32Array(left.fftSize);
    const r = new Float32Array(right.fftSize);
    let frame = 0;
    let shown = 1;
    const tick = () => {
      left.getFloatTimeDomainData(l);
      right.getFloatTimeDomainData(r);
      let lr = 0;
      let ll = 0;
      let rr = 0;
      for (let index = 0; index < l.length; index += 1) {
        const a = l[index] ?? 0;
        const b = r[index] ?? 0;
        lr += a * b;
        ll += a * a;
        rr += b * b;
      }
      const energy = Math.sqrt(ll * rr);
      const value = energy > 1e-9 ? lr / energy : 1;
      shown += (value - shown) * 0.2;
      correlation.set(shown);

      const chain = chainRef.current;
      const next: Record<string, number> = {};
      if (chain) {
        for (const [id, engine] of chain.engines) {
          const readings = engine.readings?.();
          if (!readings) {
            continue;
          }
          const bands = readings.bandGainReductionDb
            ? Object.values(readings.bandGainReductionDb)
            : [];
          next[id] = Math.min(readings.gainReductionDb ?? 0, ...bands);
        }
      }
      reductions.set(next);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [correlation, graph, reductions]);

  // Playback.
  const currentTime = useCallback(() => {
    const now = player.current;
    const ctx = graph?.pre.context;
    if (!(now && ctx)) {
      return position.getSnapshot();
    }
    const { node, offset, startedAt } = now;
    let time = offset + (ctx.currentTime - startedAt);
    if (node.loop && node.loopEnd > node.loopStart && time >= node.loopEnd) {
      const length = node.loopEnd - node.loopStart;
      time = node.loopStart + ((time - node.loopStart) % length);
    }
    return time;
  }, [graph, position]);

  const stopPlayer = useCallback(() => {
    const now = player.current;
    if (!now) {
      return;
    }
    now.node.onended = null;
    try {
      now.node.stop();
    } catch {
      // Already stopped.
    }
    now.node.disconnect();
    player.current = null;
  }, []);
  useEffect(() => stopPlayer, [stopPlayer]);

  const startPlayer = useCallback(
    (from: number) => {
      const buffer = bufferRef.current;
      if (!(graph && buffer)) {
        return;
      }
      const ctx = graph.pre.context as AudioContext;
      ctx.resume();
      stopPlayer();
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      const { on, region } = optionsRef.current.loop;
      const [start, end] = region;
      let offset = Math.max(0, Math.min(from, buffer.duration));
      if (on && end - start > 0.05) {
        node.loop = true;
        node.loopStart = start;
        node.loopEnd = end;
        if (offset < start || offset >= end) {
          offset = start;
        }
      }
      if (offset >= buffer.duration - 0.01) {
        offset = 0;
      }
      node.connect(graph.input);
      node.onended = () => {
        if (player.current?.node === node) {
          player.current = null;
          setPlaying(false);
          position.set(0);
        }
      };
      node.start(0, offset);
      player.current = { node, offset, startedAt: ctx.currentTime };
      position.set(offset);
    },
    [graph, position, stopPlayer]
  );

  useEffect(() => {
    if (!playing) {
      return;
    }
    let frame = 0;
    const tick = () => {
      position.set(currentTime());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [currentTime, playing, position]);

  const play = useCallback(
    (on: boolean) => {
      if (on) {
        startPlayer(position.getSnapshot());
        setPlaying(true);
      } else {
        position.set(currentTime());
        stopPlayer();
        setPlaying(false);
      }
    },
    [currentTime, position, startPlayer, stopPlayer]
  );

  const seek = useCallback(
    (seconds: number) => {
      position.set(seconds);
      if (player.current) {
        startPlayer(seconds);
      }
    },
    [position, startPlayer]
  );

  // A new loop takes effect from where the playhead is.
  const loopKey = `${options.loop.on}:${options.loop.region[0]}:${options.loop.region[1]}`;
  useEffect(() => {
    if (player.current) {
      startPlayer(currentTime());
    }
    // The loop is read from the options ref when the player restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loopKey]);

  useEffect(() => stopPlayer, [stopPlayer]);

  const load = useCallback(
    async (blob: Blob, name: string) => {
      const ctx = webAudio.getContext();
      if (!ctx) {
        return;
      }
      stopPlayer();
      setPlaying(false);
      setLoading(true);
      setError(null);
      try {
        const decoded = await decodeAudioChannels(ctx, await blob.arrayBuffer());
        const channels = toStereo(decoded);
        const buffer = ctx.createBuffer(2, channels[0]?.length ?? 0, ctx.sampleRate);
        channels.forEach((channel, index) =>
          buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, index)
        );
        bufferRef.current = buffer;
        position.set(0);
        clearInputLoudness();
        clearOutputLoudness();
        loadCount.current += 1;
        const loaded: LoadedSong = {
          channels,
          duration: buffer.duration,
          id: loadCount.current,
          loudness: null,
          name,
          peaks: computePeaks(channels, PEAK_COUNT),
          sampleRate: ctx.sampleRate,
          sourceChannels: decoded.length,
        };
        setSong(loaded);
        // Measured once the waveform is on screen: it takes a moment on a long song.
        requestAnimationFrame(() =>
          setTimeout(() => {
            const loudness = measureLoudness(channels, ctx.sampleRate);
            setSong((current) =>
              current === loaded ? { ...loaded, loudness } : current
            );
          })
        );
      } catch (refused) {
        setError(
          refused instanceof Error
            ? `Could not read ${name}: ${refused.message}`
            : `Could not read ${name}.`
        );
      } finally {
        setLoading(false);
      }
    },
    [clearInputLoudness, clearOutputLoudness, position, stopPlayer]
  );

  return {
    correlation,
    error,
    inputLevel,
    inputLevels,
    inputLoudness,
    inputSpectrum,
    load,
    loading,
    matchDb,
    outputLevels,
    outputLoudness,
    outputSpectrum,
    play,
    playing,
    position,
    ready: graph !== null,
    reductions,
    seek,
    song,
  };
}

export type MasteringSession = ReturnType<typeof useMasteringSession>;
