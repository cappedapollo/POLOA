"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const rockerSwitchVariants = cva(
  "rounded-lg bg-muted p-[3px] shadow-inner outline-none ring-1 ring-border transition-shadow focus-visible:ring-2 focus-visible:ring-ring data-disabled:cursor-not-allowed data-disabled:opacity-50 group/rocker inline-flex shrink-0",
  {
    compoundVariants: [
      {
        className: "h-14 w-8 text-[0.6875rem]",
        orientation: "vertical",
        size: "default",
      },
      {
        className: "h-10 w-6 text-[0.5625rem]",
        orientation: "vertical",
        size: "sm",
      },
      {
        className: "h-8 w-14 text-[0.6875rem]",
        orientation: "horizontal",
        size: "default",
      },
      {
        className: "h-6 w-10 text-[0.5625rem]",
        orientation: "horizontal",
        size: "sm",
      },
    ],
    defaultVariants: { orientation: "vertical", size: "default" },
    variants: {
      /** Stood up, on at the top, or laid down, on at the right. */
      orientation: {
        horizontal: "",
        vertical: "",
      },
      size: {
        default: "",
        sm: "",
      },
    },
  }
);

export interface RockerSwitchProps
  extends Omit<SwitchPrimitive.Root.Props, "children" | "className">,
    VariantProps<typeof rockerSwitchVariants> {
  className?: string;
  /** What the off side reads. @default "O" */
  offLabel?: ReactNode;
  /** What the on side reads. @default "I" */
  onLabel?: ReactNode;
}

/**
 * A rocker, as on a mixer's or a synth's panel: one cap in a bezel that tips
 * on its middle, the side pressed down sloping into the panel and the other
 * standing out, the on side lit while it is on. A switch underneath, with its
 * role, its keyboard (Space) and its form value; name it with `aria-label`.
 */
export function RockerSwitch({
  className,
  offLabel = "O",
  onLabel = "I",
  orientation,
  size,
  ...props
}: RockerSwitchProps) {
  return (
    <SwitchPrimitive.Root
      className={cn(rockerSwitchVariants({ orientation, size }), className)}
      data-orientation={orientation ?? "vertical"}
      data-size={size ?? "default"}
      data-slot="rocker-switch"
      {...props}
    >
      <span
        aria-hidden="true"
        className="rounded-md overflow-hidden bg-border shadow-sm flex flex-1 gap-px group-data-[orientation=horizontal]/rocker:flex-row-reverse group-data-[orientation=vertical]/rocker:flex-col"
        data-slot="rocker-switch-cap"
      >
        {/* Each side slopes toward its own edge: `--rocker-edge` is where that edge is. */}
        <span
          className="font-mono font-semibold text-muted-foreground transition-[color,box-shadow] duration-100 bg-[linear-gradient(var(--rocker-edge),color-mix(in_oklab,white_6%,var(--muted)),color-mix(in_oklab,white_16%,var(--muted)))] group-data-checked/rocker:bg-[linear-gradient(var(--rocker-edge),color-mix(in_oklab,black_4%,var(--muted)),color-mix(in_oklab,black_14%,var(--muted)))] group-data-checked/rocker:text-primary group-data-checked/rocker:shadow-[inset_0_0_3px_rgb(0_0_0/0.18)] flex flex-1 items-center justify-center group-data-[orientation=horizontal]/rocker:[--rocker-edge:to_right] group-data-[orientation=vertical]/rocker:[--rocker-edge:to_top]"
          data-slot="rocker-switch-on"
        >
          {onLabel}
        </span>
        <span
          className="font-mono font-semibold text-muted-foreground transition-[color,box-shadow] duration-100 bg-[linear-gradient(var(--rocker-edge),color-mix(in_oklab,black_4%,var(--muted)),color-mix(in_oklab,black_14%,var(--muted)))] shadow-[inset_0_0_3px_rgb(0_0_0/0.18)] group-data-checked/rocker:bg-[linear-gradient(var(--rocker-edge),color-mix(in_oklab,white_6%,var(--muted)),color-mix(in_oklab,white_16%,var(--muted)))] group-data-checked/rocker:shadow-none flex flex-1 items-center justify-center group-data-[orientation=horizontal]/rocker:[--rocker-edge:to_left] group-data-[orientation=vertical]/rocker:[--rocker-edge:to_bottom]"
          data-slot="rocker-switch-off"
        >
          {offLabel}
        </span>
      </span>
    </SwitchPrimitive.Root>
  );
}