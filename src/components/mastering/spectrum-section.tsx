"use client";

import type { Source } from "@audio-ui/react";
import { useState } from "react";
import { SpectrumAnalyzer } from "@/components/audio-ui/spectrum-analyzer";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

interface SpectrumSectionProps {
  input: Source<Float32Array>;
  output: Source<Float32Array>;
}

/** The live spectrum of the master, or of the source going in, with held peaks. */
export function SpectrumSection({ input, output }: SpectrumSectionProps) {
  const [tap, setTap] = useState<"in" | "out">("out");
  return (
    <section
      aria-label="Spectrum"
      className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-3"
    >
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
          Spectrum
        </h3>
        <ToggleGroup
          aria-label="Spectrum of"
          onValueChange={(value: string[]) => {
            const next = value[0];
            if (next === "in" || next === "out") {
              setTap(next);
            }
          }}
          size="sm"
          spacing={0}
          value={[tap]}
          variant="outline"
        >
          <ToggleGroupItem value="in">In</ToggleGroupItem>
          <ToggleGroupItem value="out">Out</ToggleGroupItem>
        </ToggleGroup>
      </div>
      <SpectrumAnalyzer
        aria-label={tap === "out" ? "Master spectrum" : "Source spectrum"}
        className="h-44"
        key={tap}
        maxDb={-10}
        minDb={-100}
        source={tap === "out" ? output : input}
      />
    </section>
  );
}
