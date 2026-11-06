"use client"

import { useSheetHeight } from "./sheet-height"

import { Drawer } from "@base-ui/react/drawer"
import { X } from "lucide-react"
import type { ReactNode, RefObject } from "react"

import { cn } from "../../lib/utils"

function Sheet({
  open,
  onClose,
  title,
  container,
  snapPoints,
  finalFocus,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  /** What the sheet covers; the screen when null. */
  container: HTMLElement | null
  /** The heights it rests at, as Base UI's Drawer reads them: a fraction of the screen's height, or pixels. */
  snapPoints?: Drawer.Root.SnapPoint[] | undefined
  /** Where focus goes once it closes, when what opened it is gone by then. */
  finalFocus?: RefObject<HTMLElement | null>
  className?: string
  children: ReactNode
}) {
  const [popup, content] = useSheetHeight(Boolean(snapPoints))
  const screen = container ? undefined : ""
  const snaps = snapPoints ? "" : undefined
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      snapPoints={snapPoints}
      defaultSnapPoint={snapPoints?.[0]}
    >
      <Drawer.Portal container={container ?? undefined}>
        <Drawer.Backdrop className="sheet-backdrop" data-screen={screen} data-snaps={snaps} />
        <Drawer.Viewport className="sheet-viewport" data-screen={screen}>
          <Drawer.Popup ref={popup} className={cn("sheet", className)} data-snaps={snaps} finalFocus={finalFocus}>
            <Drawer.Content ref={content} className="sheet-content">
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
