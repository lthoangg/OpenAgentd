import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-1 text-sm text-(--color-text) transition-colors outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-(--color-text) placeholder:text-(--color-text-subtle) hover:border-(--color-border-strong) focus-visible:border-(--focus-ring) focus-visible:ring-2 focus-visible:ring-(--focus-ring)/25 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-(--bg-key) disabled:text-(--color-text-muted) disabled:opacity-60 aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
