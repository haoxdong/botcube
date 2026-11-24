"use client";

import { carriesFiles } from "./keep-file-drops";
import { Shows } from "./motion";

import { useEffect, useRef, useState, type ComponentProps, type DragEvent, type RefObject } from "react";
import { FilePlusCorner, Paperclip, Plus } from "lucide-react";
import { cn, zoomOf } from "@/lib/utils";
import { InputGroupButton } from "@/components/ui/input-group";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { composerEdges } from "./composer-edges";
import type { ComposerFiles } from "./composer-files";

// The ways files reach the composer besides pasting into its text: its + menu, and dropping them on the chat.

/** The composer's +: the one face of its add button, on the live composer's menu and on a kept chat's still copy. */
export function AddButton({ className, ...props }: ComponentProps<typeof InputGroupButton>) {
  return (
    <InputGroupButton size="icon-sm" data-testid="copilot-add-menu-button" aria-label="Add photos & files" {...props} className={cn("composer-add rounded-full focus-visible:bg-(--color-fill) focus-visible:text-(--color-text)", className)}>
      <Plus aria-hidden />
    </InputGroupButton>
  );
}

/**
 * The composer's + and its stock menu, opening over the composer's left edge, whose items open the file
 * picker, Add photos for images and Add files for any file.
 */
export function AddMenu({ picker }: { picker: RefObject<HTMLInputElement | null> }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const addFile = (accept = "") => {
    if (!picker.current) return;
    picker.current.accept = accept;
    picker.current.click();
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger ref={trigger} render={<AddButton />} />
      <DropdownMenuContent className="add-menu" side="top" sideOffset={() => composerEdges(trigger.current).above + 8 * zoomOf(trigger.current)} alignOffset={() => -composerEdges(trigger.current).left}>
        <DropdownMenuItem onClick={() => addFile("image/*")}>
          <Paperclip aria-hidden />
          Add photos
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => addFile()}>
          <FilePlusCorner aria-hidden />
          Add files
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A drop's files, without its folders, which arrive as files too and only their entries tell apart. */
function droppedFiles(data: DataTransfer): File[] {
  return [...data.items].flatMap((item) => {
    if (item.kind !== "file" || item.webkitGetAsEntry()?.isDirectory) return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

/**
 * The chat's drop target: files dragged over it show "Drop files to attach" and, dropped, attach as the + would. Each
 * enter into the chat or a child comes before the leave from where the drag was, so a count of them is 0 once the drag
 * has left the chat; Safari's leaves name no element they go to. The sheet takes the pointer once it shows, so the
 * count stays true as messages change under it, and a drop or end anywhere in the page resets it. The handlers
 * capture, since CopilotChat's own stop every leave and drop from bubbling.
 */
export function useFileDrop(add: ComposerFiles["add"]) {
  const [over, setOver] = useState(false);
  const entered = useRef(0);
  const end = () => {
    entered.current = 0;
    setOver(false);
  };
  useEffect(() => {
    if (!over) return undefined;
    const reset = () => {
      entered.current = 0;
      setOver(false);
    };
    window.addEventListener("drop", reset);
    window.addEventListener("dragend", reset);
    return () => {
      window.removeEventListener("drop", reset);
      window.removeEventListener("dragend", reset);
    };
  }, [over]);
  return {
    over,
    handlers: {
      onDragEnterCapture: (event: DragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        entered.current += 1;
        setOver(true);
      },
      onDragOverCapture: (event: DragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      },
      onDragLeaveCapture: (event: DragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        entered.current -= 1;
        if (entered.current <= 0) end();
      },
      onDropCapture: (event: DragEvent) => {
        if (!carriesFiles(event.dataTransfer)) return;
        event.preventDefault();
        end();
        const files = droppedFiles(event.dataTransfer);
        if (files.length > 0) add(files);
      },
    },
  };
}

/** The quiet sheet over the chat while files are dragged over it, fading in and out. */
export function FileDropOverlay({ open }: { open: boolean }) {
  return <Shows appear when={open} className="file-drop">Drop files to attach</Shows>;
}
