import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        // Layout
        "flex field-sizing-content min-h-24 w-full rounded-sm border",
        // Surface — matches Input primitive
        "border-(--color-border) bg-(--bg-input)",
        // Typography — text-xs consistent with Input; callers override for code (text-[13px])
        "px-2.5 py-2 text-xs leading-relaxed text-(--color-text)",
        // Placeholder
        "placeholder:text-(--color-text-muted)/60",
        // Interaction — no hover border jump
        "outline-none transition-colors",
        "focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/30",
        // States
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
