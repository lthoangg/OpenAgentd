import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap text-(--color-text) transition-all outline-none select-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-(--color-error) aria-invalid:ring-2 aria-invalid:ring-(--color-error)/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "border-(--color-accent) bg-(--color-accent) text-(--color-text-on-accent) hover:opacity-90",
        outline:
          "border-(--color-border) bg-(--bg-page) hover:border-(--color-border-strong) hover:bg-(--bg-key) aria-expanded:border-(--color-border-strong) aria-expanded:bg-(--bg-key)",
        secondary:
          "border-(--color-border) bg-(--bg-key) text-(--color-text) hover:bg-(--color-surface-2) aria-expanded:bg-(--color-surface-2)",
        ghost:
          "bg-transparent hover:bg-(--bg-key) hover:text-(--color-text) aria-expanded:bg-(--bg-key)",
        destructive:
          "border-(--color-error)/25 bg-(--color-error-subtle) text-(--color-error) hover:bg-(--color-error)/15 focus-visible:ring-(--color-error)/20",
        link: "bg-transparent text-(--accent-blue-text) underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-9 gap-1.5 px-3 has-data-[icon=inline-end]:pr-2.5 has-data-[icon=inline-start]:pl-2.5",
        xs: "h-6 gap-1 rounded-sm px-2 text-xs has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1 rounded-sm px-2.5 text-[0.8rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-1.5 px-4 has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        icon: "size-9",
        "icon-xs":
          "size-6 rounded-sm [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-8 rounded-sm",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export { Button, buttonVariants }
