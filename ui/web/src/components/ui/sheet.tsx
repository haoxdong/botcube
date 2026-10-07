"use client"

import { Drawer } from "@base-ui/react/drawer"
import { X } from "lucide-react"
import type { ReactNode } from "react"

import { cn } from "../../lib/utils"

/**
 * An iOS sheet that rises from the bottom of `container` over a dimmed backdrop: a grabber over a title bar with its
 * close at the left and the title centred, as the phone's Edit profile sheet has, over its body. A tap on the backdrop,
 * Escape, or a finger swiping it down closes it; a mouse drag does not, so a desktop selects its text instead.
 */
function Sheet({
  open,
  onClose,
  title,
  container,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** What the sheet covers; the screen when null. */
  container: HTMLElement | null
  className?: string
  children: ReactNode
}) {
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Drawer.Portal container={container ?? undefined}>
        <Drawer.Backdrop className="sheet-backdrop" />
        <Drawer.Viewport className="sheet-viewport">
          <Drawer.Popup className={cn("sheet", className)}>
            <Drawer.Content className="sheet-content">
              <div className="sheet-grabber" aria-hidden />
              <div className="sheet-head">
                <Drawer.Close className="header-btn sheet-close" aria-label="Close">
                  <X size={20} aria-hidden />
                </Drawer.Close>
                <Drawer.Title className="sheet-title">{title}</Drawer.Title>
              </div>
              {children}
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  )
}

export { Sheet }
