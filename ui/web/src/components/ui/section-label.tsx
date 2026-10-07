"use client"

import { useRender } from "@base-ui/react/use-render"

import { cn } from "../../lib/utils"

/** A section's name in small grey capitals, above the rows it names. */
function SectionLabel({ className, render, ...props }: useRender.ComponentProps<"h2">) {
  return useRender({
    defaultTagName: "h2",
    render,
    props: { ...props, className: cn("section-label", className) },
  })
}

export { SectionLabel }
