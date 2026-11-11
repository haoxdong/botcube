"use client";

import { carriesFiles } from "./keep-file-drops";

import { useEffect, useRef, useState, type DragEvent, type RefObject } from "react";
import { Menu } from "@base-ui/react/menu";
import { FilePlusCorner, Paperclip, Plus } from "lucide-react";
import { zoomOf } from "@/lib/utils";
import type { ComposerFiles } from "./composer-files";
import { Fade } from "./collapse";

// The ways files reach the composer besides pasting into its text: its + menu, and dropping them on the chat.

function NoAddMenuButton() {
  return null;
}

/**
 * The composer's + and its menu, as ChatGPT's: a white popover over the composer's left edge whose items open the file
 * picker, Add photos for images and Add files for any file. CopilotKit's own menu draws no icons.
 */
function AddMenu({ disabled, onAddFile }: { disabled?: boolean | undefined; onAddFile?: ((accept?: string) => void) | undefined }) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Menu.Root>
      <Menu.Trigger ref={trigger} data-testid="copilot-add-menu-button" aria-label="Add photos & files" disabled={disabled ?? false}>
        <Plus size={20} aria-hidden />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="add-menu-positioner" anchor={() => trigger.current?.closest(".copilotKitInput") ?? null} side="top" align="start" sideOffset={() => 8 * zoomOf(trigger.current)}>
          <Menu.Popup className="add-menu">
            <Menu.Item className="add-menu-item" onClick={() => onAddFile?.("image/*")}>
              <Paperclip size={20} aria-hidden />
              Add photos
            </Menu.Item>
            <Menu.Item className="add-menu-item" onClick={() => onAddFile?.()}>
              <FilePlusCorner size={20} aria-hidden />
              Add files
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * The + slot: with files to attach, our menu, whose items open the file picker for the types they name, and any file
 * from CopilotKit's slash menu; none with nothing to add.
 */
export function addMenuSlot(attached: ComposerFiles | null, picker: RefObject<HTMLInputElement | null>) {
  if (!attached) return { addMenuButton: NoAddMenuButton };
  const onAddFile = (accept = "") => {
    if (!picker.current) return;
    picker.current.accept = accept;
    picker.current.click();
  };
  return { addMenuButton: AddMenu, onAddFile };
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
  return <Fade open={open} className="file-drop">Drop files to attach</Fade>;
}
