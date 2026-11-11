"use client";

import type { Source } from "@audio-ui/react";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { DeviceBrowser } from "@/components/audio-ui/device-browser";
import {
  DeviceChain,
  DeviceChainAdd,
  DeviceChainSlot,
  DeviceChainSlotControls,
} from "@/components/audio-ui/device-chain";
import {
  type DevicePanelProps,
  devicePanel,
} from "@/components/audio-ui/device-panels";
import { type AnyDeviceState, libraryDevice } from "@/lib/device-library";
import { type ChainSlot, MASTERING_LIBRARY } from "@/lib/mastering/chain";

/** The panels that draw a live spectrum behind their curve. */
const WITH_SPECTRUM = new Set([
  "audioui.equalizer",
  "audioui.channel-eq",
  "audioui.multiband",
  "audioui.deesser",
]);
/** The panels that ride the level going in on their transfer curve. */
const WITH_LEVEL = new Set(["audioui.compressor"]);

type LivePanel = ComponentType<
  DevicePanelProps & {
    level?: Source<number>;
    spectrum?: Source<Float32Array>;
  }
>;

/** How much a device is taking off, beside its name in the title bar. */
function ReductionBadge({
  id,
  reductions,
}: {
  id: string;
  reductions: Source<Readonly<Record<string, number>>>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let shown = "";
    const sync = () => {
      const element = ref.current;
      if (!element) {
        return;
      }
      const value = reductions.getSnapshot()[id];
      element.hidden = value === undefined;
      const text =
        value === undefined || Math.abs(value) < 0.05 ? "0.0" : value.toFixed(1);
      if (text !== shown) {
        shown = text;
        element.textContent = `GR ${text}`;
        element.toggleAttribute("data-active", (value ?? 0) < -0.5);
      }
    };
    sync();
    return reductions.subscribe(sync);
  }, [id, reductions]);
  return (
    <span
      className="me-1 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums data-active:bg-warning/15 data-active:text-warning"
      hidden
      ref={ref}
      title="Gain reduction"
    />
  );
}

interface ChainSectionProps {
  inputLevel: Source<number>;
  onAdd: (device: string, index?: number) => void;
  onChange: (id: string, state: AnyDeviceState) => void;
  onMove: (id: string, index: number) => void;
  onRemove: (id: string) => void;
  reductions: Source<Readonly<Record<string, number>>>;
  slots: readonly ChainSlot[];
  spectrum: Source<Float32Array>;
}

/**
 * The master chain: the library of devices beside a row of the chain's
 * devices in signal order, each drawn by its own panel. Drag a device from the
 * library onto the row, drag a title bar to reorder, fold what you are not
 * touching, and switch any stage off from its square.
 */
export function ChainSection({
  inputLevel,
  onAdd,
  onChange,
  onMove,
  onRemove,
  reductions,
  slots,
  spectrum,
}: ChainSectionProps) {
  const [browserOpen, setBrowserOpen] = useState(true);
  const searchRef = useRef<HTMLInputElement>(null);
  const openLibrary = useCallback(() => {
    setBrowserOpen(true);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, []);
  const pick = useCallback((device: string) => onAdd(device), [onAdd]);

  return (
    <section
      aria-label="Master chain"
      className="flex min-h-0 min-w-0 gap-2 rounded-xl border bg-card/40 p-2"
    >
      <DeviceBrowser
        className="h-[25rem] shrink-0 border rounded-lg overflow-hidden"
        onOpenChange={setBrowserOpen}
        onPick={pick}
        open={browserOpen}
        searchRef={searchRef}
        shelves={MASTERING_LIBRARY}
      />
      <DeviceChain
        aria-label="Devices, in signal order"
        className="h-[25rem] min-w-0 flex-1"
        onAdd={onAdd}
        onMove={onMove}
        onRemove={onRemove}
        order={slots.map((slot) => slot.id)}
      >
        {slots.map((slot) => {
          const entry = devicePanel(slot.device);
          const device = libraryDevice(slot.device);
          if (!(entry && device)) {
            return null;
          }
          const Panel = entry.Panel as LivePanel;
          const enabled = slot.state.enabled !== false;
          return (
            <DeviceChainSlot
              className={entry.width}
              enabled={enabled}
              key={slot.id}
              onEnabledChange={(on) =>
                onChange(slot.id, { ...slot.state, enabled: on })
              }
              title={device.device.name}
              value={slot.id}
            >
              <Panel
                className="h-full"
                level={WITH_LEVEL.has(slot.device) ? inputLevel : undefined}
                onValueChange={(state) => onChange(slot.id, state)}
                spectrum={
                  WITH_SPECTRUM.has(slot.device) ? spectrum : undefined
                }
                value={slot.state}
              >
                <ReductionBadge id={slot.id} reductions={reductions} />
                <DeviceChainSlotControls />
              </Panel>
            </DeviceChainSlot>
          );
        })}
        <DeviceChainAdd onClick={openLibrary} />
      </DeviceChain>
    </section>
  );
}
