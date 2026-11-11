"use client"

import { Loader2Icon } from "lucide-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { MixWorkspace } from "@/components/mixing/mix-workspace"
import type { ArrangementDoc } from "@/lib/arrangement-state"
import { renderDemoStems } from "@/lib/mastering/demo-track"
import {
  clearMixDoc,
  demoMix,
  emptyMix,
  loadMixDoc,
  loadRecordings,
  pruneRecordings,
  type Recording,
  saveMixDoc,
  saveRecordings,
} from "@/lib/mixing/session"
import { webAudio } from "@/lib/web-audio"

const SAVE_MS = 400

interface Session {
  doc: ArrangementDoc
  key: number
  recordings: ReadonlyMap<string, Recording>
}

const playedBy = (doc: ArrangementDoc) =>
  new Set(doc.clips.flatMap((clip) => (clip.recording ? [clip.recording] : [])))

/**
 * The mix as a session that outlives a refresh: the arrangement kept in
 * localStorage as it changes, its recordings in IndexedDB, both restored on
 * load. A demo or a new mix starts the desk over with a document of its own.
 */
export function MixStudio({
  active,
  onBounce,
}: {
  active: boolean
  onBounce: (file: File) => void
}) {
  const [session, setSession] = useState<Session | null>(null)
  const [status, setStatus] = useState<string | null>("Restoring the mix…")
  const latest = useRef<ArrangementDoc | null>(null)
  const timer = useRef(0)

  useEffect(() => {
    let live = true
    ;(async () => {
      const doc = loadMixDoc() ?? emptyMix()
      const recordings = await loadRecordings().catch(
        () => new Map<string, Recording>()
      )
      const used = playedBy(doc)
      pruneRecordings(used).catch(() => undefined)
      if (live) {
        setSession({
          doc,
          key: 1,
          recordings: new Map([...recordings].filter(([id]) => used.has(id))),
        })
        setStatus(null)
      }
    })()
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    const flush = () => {
      window.clearTimeout(timer.current)
      if (latest.current) {
        saveMixDoc(latest.current)
      }
    }
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("pagehide", flush)
      flush()
    }
  }, [])

  const keepDoc = useCallback((doc: ArrangementDoc) => {
    latest.current = doc
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => saveMixDoc(doc), SAVE_MS)
  }, [])
  const keepRecordings = useCallback(
    (added: ReadonlyMap<string, Recording>) => {
      saveRecordings(added).catch(() =>
        setStatus(
          "The stems are too large to keep in this browser: they play, but will not come back after a refresh."
        )
      )
    },
    []
  )

  const startOver = useCallback(
    async (doc: ArrangementDoc, recordings: ReadonlyMap<string, Recording>) => {
      window.clearTimeout(timer.current)
      latest.current = doc
      saveMixDoc(doc)
      await pruneRecordings(new Set()).catch(() => undefined)
      await saveRecordings(recordings).catch(() => undefined)
      setSession((current) => ({
        doc,
        key: (current?.key ?? 0) + 1,
        recordings,
      }))
    },
    []
  )

  const replacing = () => (latest.current?.tracks.length ?? 0) > 0
  const loadDemo = useCallback(async () => {
    if (
      replacing() &&
      !window.confirm("Replace the current mix with the demo stems?")
    ) {
      return
    }
    setStatus("Rendering the demo stems…")
    try {
      const sampleRate = webAudio.getContext()?.sampleRate ?? 48_000
      const { doc, recordings } = demoMix(
        await renderDemoStems(sampleRate),
        sampleRate
      )
      await startOver(doc, recordings)
    } finally {
      setStatus(null)
    }
  }, [startOver])
  const newMix = useCallback(async () => {
    if (
      replacing() &&
      !window.confirm(
        "Start a new mix? The tracks and stems of this one are cleared."
      )
    ) {
      return
    }
    clearMixDoc()
    await startOver(emptyMix(), new Map())
  }, [startOver])

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {status ? (
        <p
          aria-live="polite"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          {status.endsWith("…") ? (
            <Loader2Icon className="size-4 animate-spin" />
          ) : null}
          {status}
        </p>
      ) : null}
      {session ? (
        <MixWorkspace
          active={active}
          initialDoc={session.doc}
          initialRecordings={session.recordings}
          key={session.key}
          onBounce={onBounce}
          onDocChange={keepDoc}
          onLoadDemo={loadDemo}
          onNewMix={newMix}
          onRecordingsAdded={keepRecordings}
        />
      ) : null}
    </div>
  )
}
