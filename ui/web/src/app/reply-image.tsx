"use client";

import { useContext, useEffect, useRef, useState, type ComponentProps } from "react";
import { DownloadIcon } from "lucide-react";
import { webUiPlugin } from "@cartridge-ui";

import { replyFilePath } from "./reply-file-path";
import { ReplyImageTurnRunning } from "./reply-image-turn";

type ImageAttempt =
  | { status: "image"; url: string; recoverAfterTurn: boolean }
  | { status: "browser-error"; error: string; recoverAfterTurn: boolean }
  | { status: "refreshing"; error: string }
  | { status: "file-error"; error: string };

/** Saves the image at `url` under its own file name, as streamdown's own image download does. */
async function saveImage(url: string) {
  const blob = await (await fetch(url)).blob();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = new URL(url, window.location.origin).pathname.split("/").pop() || "image";
  link.click();
  URL.revokeObjectURL(link.href);
}

/** The reason a failure carries, for the line that names it. */
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * An image an assistant reply embeds, in place of streamdown's own and with its look and Download button. An image
 * the reply names by a path is one of the agent's files: it shows from the short-lived URL the Cartridge's `fileUrl`
 * gives it, and downloads from a fresh one; one that fails to show is named in its place. Without `fileUrl`, a path
 * stays as written.
 */
export function ReplyImage({ src, alt, title }: ComponentProps<"img">) {
  const path = typeof src === "string" && webUiPlugin.fileUrl ? replyFilePath(src) : null;
  const running = useContext(ReplyImageTurnRunning);
  const runningNow = useRef(running);
  runningNow.current = running;
  const [shown, setShown] = useState<ImageAttempt | null>(path ? null : { status: "image", url: typeof src === "string" ? src : "", recoverAfterTurn: false });
  const [downloadError, setDownloadError] = useState<string | null>(null);
  useEffect(() => {
    if (!path || !webUiPlugin.fileUrl) return;
    let current = true;
    const recoverAfterTurn = runningNow.current;
    setShown(null);
    webUiPlugin.fileUrl(path).then(
      (url) => current && setShown({ status: "image", url, recoverAfterTurn }),
      (error: unknown) => current && setShown({ status: "file-error", error: reason(error) }),
    );
    return () => {
      current = false;
    };
  }, [path]);

  useEffect(() => {
    if (!running && shown?.status === "browser-error" && shown.recoverAfterTurn) {
      setShown({ status: "refreshing", error: shown.error });
    }
  }, [running, shown]);
  useEffect(() => {
    if (shown?.status !== "refreshing" || !path || !webUiPlugin.fileUrl) return;
    let current = true;
    webUiPlugin.fileUrl(path).then(
      (url) => current && setShown({ status: "image", url, recoverAfterTurn: false }),
      (error: unknown) => current && setShown({ status: "file-error", error: reason(error) }),
    );
    return () => {
      current = false;
    };
  }, [path, shown]);

  if (shown === null || (shown.status === "image" && !shown.url)) return null;
  if (shown.status !== "image") return <span role="alert">{`${alt || path} could not load: ${shown.error}`}</span>;
  const download = () => {
    setDownloadError(null);
    void (path && webUiPlugin.fileUrl ? webUiPlugin.fileUrl(path).then((url) => window.location.assign(url)) : saveImage(shown.url)).catch(
      (error: unknown) => setDownloadError(reason(error)),
    );
  };
  return (
    <>
      <div className="group relative my-4 inline-block" data-streamdown="image-wrapper">
        <img
          alt={alt}
          className="max-w-full rounded-lg"
          data-streamdown="image"
          onError={path ? () => setShown({ status: "browser-error", error: "the browser could not show it", recoverAfterTurn: shown.recoverAfterTurn }) : undefined}
          src={shown.url}
          title={title}
        />
        <div className="pointer-events-none absolute inset-0 hidden rounded-lg bg-black/10 group-hover:block" />
        <button
          className="absolute right-2 bottom-2 flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-border bg-background/90 shadow-sm backdrop-blur-sm transition-all duration-200 hover:bg-background opacity-0 group-hover:opacity-100"
          onClick={download}
          title="Download image"
          type="button"
        >
          <DownloadIcon size={14} />
        </button>
      </div>
      {downloadError && <span role="alert">{`${alt || "The image"} could not download: ${downloadError}`}</span>}
    </>
  );
}
