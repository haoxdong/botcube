import type { ComponentProps } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";

export function MenuButton({ faded = false, className, children, ...props }: ComponentProps<typeof Button> & { faded?: boolean }) {
  const state = faded ? { render: <span aria-hidden />, nativeButton: false, tabIndex: -1 } : { "aria-label": "Toggle sidebar" };
  return (
    <Button variant="outline" size="icon-lg" className={cn(faded ? "sidebar-strip-close-menu" : "sidebar-logo-btn", "rounded-full", className)} {...state} {...props}>
      <svg className="sidebar-icon-menu" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <path d="M2 8h20" />
        <path d="M2 16h12.5" />
      </svg>
      {children}
    </Button>
  );
}
