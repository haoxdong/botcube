import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

/** A sidebar row (Main chat, Customize): an icon and a label, filled while its screen is open. */
function SidebarRow({
  active = false,
  className,
  ...props
}: ComponentProps<"button"> & { active?: boolean }) {
  return (
    <button
      className={cn("sidebar-nav-item", active && "sidebar-nav-item-active", className)}
      {...props}
    />
  )
}

export { SidebarRow }
