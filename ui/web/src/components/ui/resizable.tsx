"use client"

import * as ResizablePrimitive from "react-resizable-panels"

import { cn } from "../../lib/utils"

// shadcn/ui's Resizable (react-resizable-panels 4), styled from the app's tokens in artifacts.css.
function ResizablePanelGroup({ className, ...props }: ResizablePrimitive.GroupProps) {
  return <ResizablePrimitive.Group data-slot="resizable-panel-group" className={cn("resizable-group", className)} {...props} />
}

function ResizablePanel(props: ResizablePrimitive.PanelProps) {
  return <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />
}

function ResizableHandle({ className, ...props }: ResizablePrimitive.SeparatorProps) {
  return <ResizablePrimitive.Separator data-slot="resizable-handle" className={cn("resizable-handle", className)} {...props} />
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
