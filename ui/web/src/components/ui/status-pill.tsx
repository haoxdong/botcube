import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

/** A small pill naming a state, on a soft tint of its tone's colour. */
function StatusPill({
  tone = "neutral",
  className,
  ...props
}: ComponentProps<"span"> & { tone?: "neutral" | "blue" | "danger" }) {
  return (
    <span
      className={cn("status-pill", tone !== "neutral" && `status-pill-${tone}`, className)}
      {...props}
    />
  )
}

export { StatusPill }
