import type { ComponentProps } from "react"

import { cn } from "../lib/utils"
import { Button as StockButton, buttonVariants } from "./ui/button"

const STOCK_VARIANT = { secondary: "secondary", primary: "default", destructive: "destructive" } as const
type Variant = keyof typeof STOCK_VARIANT

const PILL = "pill-button rounded-full"

/** A pill button: stock Button, rounded-full. Secondary by default, primary to commit (Save, Confirm), destructive to delete. */
function Button({
  variant = "secondary",
  className,
  ...props
}: Omit<ComponentProps<typeof StockButton>, "variant"> & { variant?: Variant }) {
  return <StockButton variant={STOCK_VARIANT[variant]} className={cn(PILL, className)} {...props} />
}

/** The pill's classes, for an element that is not a button but looks like one, as a file input's label. */
function pillButtonVariants({ variant = "secondary", className }: { variant?: Variant; className?: string } = {}) {
  return buttonVariants({ variant: STOCK_VARIANT[variant], className: cn(PILL, className) })
}

export { Button, pillButtonVariants }
