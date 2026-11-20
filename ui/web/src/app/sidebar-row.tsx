import type { ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** A sidebar row (Main chat, Apps): the stock ghost Button, filled while its screen is open. */
export function SidebarRow({
  active = false,
  className,
  ...props
}: ComponentProps<typeof Button> & { active?: boolean }) {
  return (
    <Button
      variant="ghost"
      className={cn("sidebar-nav-item", active && "sidebar-nav-item-active", className)}
      {...props}
    />
  );
}
