import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-24 w-full rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2.5 text-sm leading-relaxed text-(--color-text) transition-colors outline-none placeholder:text-(--color-text-subtle) hover:border-(--color-border-strong) focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25 disabled:cursor-not-allowed disabled:bg-(--bg-key) disabled:text-(--color-text-muted) disabled:opacity-60 aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
