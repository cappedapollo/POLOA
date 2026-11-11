import type { Meter } from "@audio-ui/react";
import type { Source } from "@audio-ui/react";
import { useMemo, useSyncExternalStore } from "react";

/** A live source read in React: for readings that change a few times a second, not every frame. */
export function useSourceValue<T>(source: Source<T>): T {
  return useSyncExternalStore(
    source.subscribe,
    source.getSnapshot,
    source.getSnapshot
  );
}

/**
 * A source derived from another, recomputed only when the one it follows
 * publishes a new snapshot, so the same value comes back between two reads.
 */
export function deriveSource<From, To>(
  source: Source<From>,
  derive: (value: From) => To
): Source<To> {
  let last: From | undefined;
  let cached: To | undefined;
  return {
    getSnapshot: () => {
      const value = source.getSnapshot();
      if (value !== last || cached === undefined) {
        last = value;
        cached = derive(value);
      }
      return cached;
    },
    subscribe: source.subscribe,
  };
}

/** One channel of a stereo meter frame, for a needle meter. */
export function useChannelSource(
  source: Source<Meter.Root.Frame>,
  channel: number
) {
  return useMemo(
    () =>
      deriveSource(source, (frame) => ({
        levels: [frame.levels[channel] ?? -100],
      })),
    [channel, source]
  );
}
