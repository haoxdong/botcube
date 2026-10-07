import type { ComponentProps, ReactNode } from "react"

import { cn } from "../../lib/utils"

/** A labelled control: its `detail` label above the input, textarea or select. */
function Field({
  label,
  className,
  children,
  ...props
}: ComponentProps<"label"> & { label: ReactNode }) {
  return (
    <label className={cn("field", className)} {...props}>
      {label}
      {children}
    </label>
  )
}

export { Field }
