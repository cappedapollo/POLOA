"use client"

import type { Tempo } from "@audio-ui/core/time"
import { useCallback, useRef, useState } from "react"
import {
  DeviceBrowser,
  type DeviceBrowserShelf,
} from "@/components/audio-ui/device-browser"
import {
  DeviceChain,
  DeviceChainAdd,
  DeviceChainSlot,
  DeviceChainSlotControls,
} from "@/components/audio-ui/device-chain"
import { devicePanel } from "@/components/audio-ui/device-panels"
import type { ArrangementTrack } from "@/lib/arrangement"
import type { ArrangementCommand } from "@/lib/arrangement-state"
import { DEVICE_LIBRARY, libraryDevice } from "@/lib/device-library"

/** Every shelf a mix reaches for: no instruments, the tracks are recordings. */
export const MIXING_LIBRARY: readonly DeviceBrowserShelf[] = [
  ...new Set(DEVICE_LIBRARY.map((item) => item.shelf)),
]
  .filter((label) => label !== "Instruments")
  .map((label) => ({
    items: DEVICE_LIBRARY.filter((item) => item.shelf === label).map(
      ({ device }) => ({
        description: device.description,
        id: device.id,
        name: device.name,
      })
    ),
    label,
  }))

interface TrackDevicesProps {
  dispatch: (command: ArrangementCommand) => unknown
  tempo: Tempo
  track: ArrangementTrack
}

/**
 * The insert chain of one track, return or the mix bus: the library beside
 * its devices in signal order, each drawn by its own panel. Every change is a
 * command of the arrangement, so it is undoable and the engine follows it.
 */
export function TrackDevices({ dispatch, tempo, track }: TrackDevicesProps) {
  const [browserOpen, setBrowserOpen] = useState(true)
  const searchRef = useRef<HTMLInputElement>(null)
  const devices = track.devices ?? []
  const add = useCallback(
    (device: string, index?: number) => {
      const entry = libraryDevice(device)
      if (entry) {
        dispatch({
          device,
          index,
          state: entry.device.defaults(),
          track: track.id,
          type: "add-device",
        })
      }
    },
    [dispatch, track.id]
  )
  const settle = useCallback(
    () => dispatch({ type: "settle-clip-edit" }),
    [dispatch]
  )
  const openLibrary = useCallback(() => {
    setBrowserOpen(true)
    requestAnimationFrame(() => searchRef.current?.focus())
  }, [])

  return (
    // A turn of a knob is a burst of changes: letting go closes it into one step of undo.
    <section
      aria-label={`${track.name} devices`}
      className="flex min-h-0 min-w-0 gap-2"
      onKeyUp={settle}
      onPointerUp={settle}
    >
      <DeviceBrowser
        className="h-[23rem] shrink-0 overflow-hidden rounded-lg border"
        onOpenChange={setBrowserOpen}
        onPick={add}
        open={browserOpen}
        searchRef={searchRef}
        shelves={MIXING_LIBRARY}
      />
      <DeviceChain
        aria-label={`${track.name} devices, in signal order`}
        className="h-[23rem] min-w-0 flex-1"
        onAdd={add}
        onMove={(id, index) =>
          dispatch({ id, index, track: track.id, type: "move-device" })
        }
        onRemove={(id) =>
          dispatch({ id, track: track.id, type: "remove-device" })
        }
        order={devices.map((item) => item.id)}
      >
        {devices.map((item) => {
          const entry = devicePanel(item.device)
          const described = libraryDevice(item.device)
          if (!(entry && described)) {
            return null
          }
          const { Panel } = entry
          return (
            <DeviceChainSlot
              className={entry.width}
              enabled={item.on !== false}
              key={item.id}
              onEnabledChange={() =>
                dispatch({
                  id: item.id,
                  track: track.id,
                  type: "toggle-device",
                })
              }
              title={described.device.name}
              value={item.id}
            >
              <Panel
                className="h-full"
                onValueChange={(state) =>
                  dispatch({
                    id: item.id,
                    state,
                    track: track.id,
                    type: "change-device",
                  })
                }
                tempo={tempo}
                value={item.state}
              >
                <DeviceChainSlotControls />
              </Panel>
            </DeviceChainSlot>
          )
        })}
        <DeviceChainAdd onClick={openLibrary} />
      </DeviceChain>
    </section>
  )
}
