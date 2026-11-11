import { ArrowRightIcon, LoaderCircleIcon, WandSparklesIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Led } from "@/components/audio-ui/led";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { LoadedSong } from "@/hooks/use-mastering-session";
import { analyzeSong } from "@/lib/mastering/analyze";
import {
  applySuggestions,
  calibrateProposal,
  type Proposal,
  suggestMaster,
} from "@/lib/mastering/assistant";
import type { ChainSlot } from "@/lib/mastering/chain";
import { cn } from "@/lib/utils";

const INPUT = "input";

type Status =
  | { phase: "analyzing" | "rendering"; pass?: number }
  | { phase: "error"; message: string }
  | { phase: "ready"; proposal: Proposal };

export interface AssistantDialogProps {
  inputGainDb: number;
  onApply: (slots: ChainSlot[], inputGainDb: number) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  slots: readonly ChainSlot[];
  song: LoadedSong;
  target: number;
}

/** Waits for the next frame, so a status set before heavy work gets painted. */
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/**
 * The mastering assistant: analyses the song, proposes settings for the
 * chain with the reasons for each, and checks them with an offline render.
 * Mount it fresh for each run.
 */
export function AssistantDialog({
  inputGainDb,
  onApply,
  onOpenChange,
  open,
  slots,
  song,
  target,
}: AssistantDialogProps) {
  const [status, setStatus] = useState<Status>({ phase: "analyzing" });
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await nextFrame();
      const analysis = analyzeSong(song.channels, song.sampleRate);
      const draft = suggestMaster(analysis, slots, { inputGainDb, target });
      if (cancelled) {
        return;
      }
      setStatus({ phase: "rendering", pass: 1 });
      const proposal = await calibrateProposal(draft, slots, song, target, (pass) => {
        if (!cancelled) {
          setStatus({ phase: "rendering", pass });
        }
      });
      if (cancelled) {
        return;
      }
      setChecked(
        new Set([...proposal.suggestions.map((item) => item.id), ...(proposal.inputGain ? [INPUT] : [])])
      );
      setStatus({ phase: "ready", proposal });
    })().catch((error: unknown) => {
      if (!cancelled) {
        setStatus({ message: error instanceof Error ? error.message : String(error), phase: "error" });
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one run per mount, with the inputs of the click
  }, []);

  const toggle = (id: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });

  const proposal = status.phase === "ready" ? status.proposal : null;
  const total = proposal ? proposal.suggestions.length + (proposal.inputGain ? 1 : 0) : 0;
  const apply = () => {
    if (!proposal) {
      return;
    }
    const chosen = proposal.suggestions.filter((item) => checked.has(item.id));
    const trim = proposal.inputGain && checked.has(INPUT) ? proposal.inputGain.to : inputGainDb;
    onApply(applySuggestions(slots, chosen), trim);
    onOpenChange(false);
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-h-[90vh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WandSparklesIcon className="size-4 text-primary" />
            AI mastering
          </DialogTitle>
          <DialogDescription>
            Settings for your chain from an analysis of “{song.name}”, aimed at {target} LUFS. Pick what to keep;
            applying is one undo step.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-4 min-h-0 overflow-y-auto px-4">
          {status.phase === "analyzing" || status.phase === "rendering" ? (
            <p className="flex items-center gap-2 py-10 text-muted-foreground" role="status">
              <LoaderCircleIcon className="size-4 animate-spin" />
              {status.phase === "analyzing"
                ? "Listening: loudness, spectrum, dynamics and stereo image…"
                : status.pass === 1
                  ? "Rendering the proposed master…"
                  : "Calibrating the limiter to the target…"}
            </p>
          ) : null}
          {status.phase === "error" ? (
            <p className="py-6 text-destructive">The analysis failed: {status.message}</p>
          ) : null}
          {proposal ? (
            <div className="flex flex-col gap-4">
              <section aria-label="Diagnosis" className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                {proposal.diagnosis.map((item) => (
                  <div className="rounded-md border px-2 py-1.5" key={item.label}>
                    <div className="flex items-center justify-between gap-1 text-[0.65rem] text-muted-foreground uppercase tracking-wide">
                      {item.label}
                      {item.verdict ? (
                        <Led
                          label={`${item.label}: ${item.verdict}`}
                          on={item.verdict !== "good"}
                          size="sm"
                          tone={item.verdict === "bad" ? "destructive" : "primary"}
                        />
                      ) : null}
                    </div>
                    <div className="font-mono text-sm tabular-nums">{item.value}</div>
                  </div>
                ))}
              </section>

              {proposal.predicted ? (
                <section
                  aria-label="Predicted master"
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-primary/40 bg-primary/5 px-3 py-2 text-xs"
                >
                  <span className="font-medium">Predicted master</span>
                  <span className="font-mono tabular-nums">{proposal.predicted.lufs.toFixed(1)} LUFS</span>
                  <span className="font-mono tabular-nums">{proposal.predicted.truePeak.toFixed(1)} dBTP</span>
                  <span className="font-mono tabular-nums">
                    PLR {(proposal.predicted.truePeak - proposal.predicted.lufs).toFixed(1)} LU
                  </span>
                  {checked.size < total ? (
                    <span className="text-muted-foreground">(with every suggestion applied)</span>
                  ) : null}
                </section>
              ) : null}

              <ul className="flex flex-col gap-2">
                {proposal.inputGain ? (
                  <SuggestionRow
                    checked={checked.has(INPUT)}
                    onToggle={() => toggle(INPUT)}
                    reasons={[proposal.inputGain.reason]}
                    rows={[
                      {
                        from: `${proposal.inputGain.from.toFixed(1)} dB`,
                        id: "trim",
                        label: "Trim",
                        to: `${proposal.inputGain.to.toFixed(1)} dB`,
                      },
                    ]}
                    title="Input trim"
                  />
                ) : null}
                {proposal.suggestions.map((item) => (
                  <SuggestionRow
                    badge={item.isNew ? "added" : undefined}
                    checked={checked.has(item.id)}
                    key={item.id}
                    onToggle={() => toggle(item.id)}
                    reasons={item.reasons}
                    rows={item.changes}
                    title={item.name}
                  />
                ))}
              </ul>

              {proposal.notes.length > 0 ? (
                <ul className="flex list-disc flex-col gap-1 ps-5 text-muted-foreground text-xs">
                  {proposal.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} variant="outline">
            Cancel
          </Button>
          <Button disabled={!proposal || checked.size === 0} onClick={apply}>
            Apply {proposal ? `${checked.size} of ${total}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SuggestionRow({
  badge,
  checked,
  onToggle,
  reasons,
  rows,
  title,
}: {
  badge?: string;
  checked: boolean;
  onToggle: () => void;
  reasons: readonly string[];
  rows: readonly { from: string; id: string; label: string; to: string }[];
  title: string;
}) {
  return (
    <li className={cn("rounded-md border p-2.5 transition-opacity", !checked && "opacity-55")}>
      <label className="flex cursor-pointer items-center gap-2 font-medium">
        <input checked={checked} className="size-4 accent-primary" onChange={onToggle} type="checkbox" />
        {title}
        {badge ? (
          <span className="rounded bg-primary/15 px-1.5 py-0.5 font-normal text-[0.65rem] text-primary uppercase">
            {badge}
          </span>
        ) : null}
        <span className="ms-auto font-normal text-muted-foreground text-xs">
          {rows.length} change{rows.length === 1 ? "" : "s"}
        </span>
      </label>
      <ul className="mt-1.5 flex list-disc flex-col gap-0.5 ps-5 text-muted-foreground text-xs">
        {reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      <dl className="mt-2 grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-x-3 gap-y-0.5 text-xs">
        {rows.map((row) => (
          <div className="flex items-center gap-1 tabular-nums" key={row.id}>
            <dt className="min-w-0 truncate text-muted-foreground">{row.label}</dt>
            <dd className="ms-auto flex items-center gap-1 font-mono">
              <span className="text-muted-foreground">{row.from}</span>
              <ArrowRightIcon className="size-3 text-muted-foreground" />
              <span>{row.to}</span>
            </dd>
          </div>
        ))}
      </dl>
    </li>
  );
}
