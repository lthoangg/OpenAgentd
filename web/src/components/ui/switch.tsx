/**
 * Switch — warm-paper rectangular toggle.
 *
 * Design language: crisp 1px border at rest, shifts to --accent-blue track
 * when checked. Rectangular (rounded-xs = 6px) to stay consistent with the
 * rest of the settings form language — no full-pill shape.
 *
 * Built on @base-ui/react/switch for correct aria-checked / keyboard semantics.
 */
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Track shape — rectangular to match the form language
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-xs border p-0.5",
        // Track at rest
        "border-(--color-border) bg-(--bg-key)",
        // Track checked — accent-blue border + fill
        "data-checked:border-(--accent-blue) data-checked:bg-(--accent-blue)",
        // Transitions
        "transition-colors duration-150",
        // Focus ring
        "outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/30",
        // Disabled
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          // Thumb shape — square-ish, matches track radius
          "block size-3.5 rounded-[3px]",
          // Thumb at rest — card surface with border
          "border border-(--color-border) bg-(--bg-card)",
          // Thumb checked — white, no border needed against blue track
          "data-checked:translate-x-4 data-checked:border-transparent data-checked:bg-white",
          // Transition
          "transition-all duration-150",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
