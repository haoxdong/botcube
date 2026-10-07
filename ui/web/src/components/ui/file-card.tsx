import type { LucideIcon } from "lucide-react"
import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

/** A file as a card: its name over a hint, its icon at the bottom right; the caller's class sets its tint. */
function FileCard({
  name,
  hint,
  Icon,
  className,
  ...props
}: ComponentProps<"button"> & { name: string; hint: string; Icon: LucideIcon }) {
  return (
    <button type="button" className={cn("file-card", className)} {...props}>
      <span className="file-card-name">{name}</span>
      <span className="file-card-hint">{hint}</span>
      <Icon className="file-card-icon" aria-hidden="true" />
    </button>
  )
}

export { FileCard }
