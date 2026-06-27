/**
 * Switch — pill toggle in the warm-paper design language.
 *
 * Track is a rounded pill. At rest: warm `--bg-key` fill with a
 * `--color-border` outline so it reads as a form control, not a button.
 * When checked the track fills with `--accent-blue`; the border disappears
 * into the fill so the shape stays clean.
 *
 * Thumb is a white circle that slides — circular because the circular
 * thumb inside a pill is the universal "this slides" affordance.
 * A square thumb inside a pill reads as a dead slider with no motion cue.
 *
 * Sizing is slightly taller than the old shadcn version (h-[22px] w-10)
 * so the thumb has breathing room and the outline reads at text-xs density.
 */
import { Switch as SwitchPrimitive } from "@base-ui/react/switch"
import { cn } from "@/lib/utils"

function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        // Track — pill shape
        "relative inline-flex h-[22px] w-10 shrink-0 cursor-pointer",
        "items-center rounded-full border p-[3px]",
        // At rest: warm neutral, visible border
        "border-(--color-border-strong) bg-(--bg-key)",
        // Checked: accent-blue fill, border dissolves into fill
        "data-checked:border-(--accent-blue) data-checked:bg-(--accent-blue)",
        // Smooth color transition
        "transition-colors duration-200",
        // Focus ring
        "outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/30 focus-visible:ring-offset-1",
        // Disabled
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          // Thumb — circle, slightly smaller than track height
          "block size-4 rounded-full",
          // White fill, subtle shadow so it reads against the warm track
          "bg-white shadow-sm",
          // Slides to the right when checked
          "translate-x-0 data-checked:translate-x-[18px]",
          // Smooth slide
          "transition-transform duration-200",
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
