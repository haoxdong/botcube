"use client"

import { useRender } from "@base-ui/react/use-render"
import type { ComponentProps } from "react"

import { cn } from "../../lib/utils"

/** A row in a list (Muse Fig 13, 15): a `ListRowIcon`, then a `ListRowText`, then anything beside it. */
function ListRow({ className, render, ...props }: useRender.ComponentProps<"li">) {
  return useRender({
    defaultTagName: "li",
    render,
    props: { ...props, className: cn("list-row", className) },
  })
}

/** The row's round icon tile, tinted when what it lists failed. */
function ListRowIcon({
  failed = false,
  className,
  ...props
}: ComponentProps<"span"> & { failed?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn("list-row-icon", failed && "list-row-icon-failed", className)}
      {...props}
    />
  )
}

/** The row's title over its detail lines. */
function ListRowText({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("list-row-text", className)} {...props} />
}

function ListRowTitle({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("list-row-title", className)} {...props} />
}

function ListRowDetail({ className, render, ...props }: useRender.ComponentProps<"span">) {
  return useRender({
    defaultTagName: "span",
    render,
    props: { ...props, className: cn("list-row-detail", className) },
  })
}

export { ListRow, ListRowIcon, ListRowText, ListRowTitle, ListRowDetail }
