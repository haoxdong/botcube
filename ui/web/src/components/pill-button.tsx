import type { ComponentProps } from "react"

import { cn } from "../lib/utils"
import { Button as StockButton } from "./ui/button"

const STOCK_VARIANT = { secondary: "secondary", primary: "default", destructive: "destructive" } as const

/** A pill button: stock Button, rounded-full. Secondary by default, primary to commit (Save, Confirm), destructive to delete. */
function Button({
  variant = "secondary",
  className,
  ...props
}: Omit<ComponentProps<typeof StockButton>, "variant"> & { variant?: keyof typeof STOCK_VARIANT }) {
  return <StockButton variant={STOCK_VARIANT[variant]} className={cn("pill-button rounded-full", className)} {...props} />
}

export { Button }
