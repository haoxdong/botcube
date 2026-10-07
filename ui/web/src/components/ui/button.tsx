import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

/** A pill button: secondary by default, primary to commit (Save, Confirm), destructive to delete. */
function Button({
  variant = "secondary",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: "secondary" | "primary" | "destructive" }) {
  return (
    <button
      className={cn("button", variant !== "secondary" && `button-${variant}`, className)}
      {...props}
    />
  )
}

export { Button }
