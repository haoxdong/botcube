/** Whether a drag carries files from the computer, not text or a link. */
export const carriesFiles = (data: DataTransfer | null) => data?.types.includes("Files") === true;

export function keepFileDropsInPage(target: Window) {
  const refuse = (event: globalThis.DragEvent) => {
    if (!carriesFiles(event.dataTransfer)) return;
    // A chat's drop target took it first.
    if (!event.defaultPrevented && event.dataTransfer) event.dataTransfer.dropEffect = "none";
    event.preventDefault();
  };
  target.addEventListener("dragover", refuse);
  target.addEventListener("drop", refuse);
  return () => {
    target.removeEventListener("dragover", refuse);
    target.removeEventListener("drop", refuse);
  };
}
