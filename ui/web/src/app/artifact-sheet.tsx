"use client";

import type { Sheet } from "botcube-artifact-check/sheet";
import { m as motionElement } from "motion/react";
import { SheetIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { artifactVersions } from "./artifact-versions";
import { baseOf } from "./files-path";
import { saveFile, storedVersion, type ArtifactVersion, type Export, type ViewerProps } from "./artifact-viewer";
import { Presence, presenceMotion } from "./collapse";
import { reason } from "./composer-files";
import type { Grid, GridPosition } from "./sheet-grid";
import { readImports } from "./sheet-import";
import { editsOf, replay, univerDataOf, type ImportedSheets } from "./sheet-model";
import { Button } from "@/components/ui/button";

type Opened = { sheet: Sheet; imported: ImportedSheets };
type Loaded = (Opened & { version: ArtifactVersion }) | { error: string } | null;

function sheetOf(text: string): Sheet {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { edits?: unknown }).edits)) {
    throw new Error('the version is not {"edits": [...]}');
  }
  return parsed as Sheet;
}

/** A stored version's edits, with the sheets its import steps read from the store's copies of their Files. */
async function openedAt({ id, version, path }: ArtifactVersion, { read, readBytes }: Pick<ViewerProps, "read" | "readBytes">): Promise<Opened> {
  const sheet = sheetOf(await read(path));
  if (!sheet.edits.some(({ kind }) => kind === "importFile")) return { sheet, imported: new Map() };
  const { imports = [] } = await artifactVersions(id, { read }).read(version);
  return { sheet, imported: await readImports(sheet, imports, readBytes) };
}

/**
 * The Sheet's Excel Export, made from the stored version on screen (ADR 0087), never from the User's unsaved typing:
 * its edits are read again and replayed by ExcelJS, loaded on Download only.
 */
export const EXCEL: Export = {
  label: "Excel",
  Icon: SheetIcon,
  failed: "the Excel file",
  stored: true,
  run: async (target) => {
    const version = storedVersion(target, "the Sheet");
    const [opened, writer] = await Promise.all([
      openedAt(version, target).catch((error: unknown) => {
        throw new Error(`reading version ${version.version} failed: ${reason(error)}`);
      }),
      import("./sheet-excel").catch((error: unknown) => {
        throw new Error(`the Excel writer didn't load: ${reason(error)}`);
      }),
    ]);
    let excel: Blob;
    try {
      excel = await writer.excelOf(opened.sheet, opened.imported);
    } catch (error) {
      throw new Error(`writing version ${version.version} failed: ${reason(error)}`);
    }
    saveFile(excel, `${version.title}.xlsx`);
  },
};

export function SheetVersion({ artifact: newest, read, readBytes, save, shows }: ViewerProps) {
  const [held, hold] = useState<ArtifactVersion | null>(null);
  const shownVersion = held ?? newest;
  const [loaded, setLoaded] = useState<Loaded>(null);
  const host = useRef<HTMLDivElement>(null);
  const grid = useRef<Grid | null>(null);
  const position = useRef<GridPosition | null>(null);
  const [mounts, remount] = useState(0);
  const [drawn, setDrawn] = useState<object | null>(null);
  const [changed, setChanged] = useState(false);
  const [failures, setFailures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const opened = loaded !== null && "sheet" in loaded ? loaded : null;
  const sheet = opened?.sheet ?? null;
  const book = useMemo(() => opened && { workbook: replay(opened.sheet, opened.imported), version: opened.version }, [opened]);
  const rendered = drawn !== null && drawn === book && book.version.path === shownVersion.path;

  useEffect(() => {
    let current = true;
    openedAt(shownVersion, { read, readBytes }).then((found) => {
      if (current) setLoaded({ ...found, version: shownVersion });
    }).catch((error: unknown) => current && setLoaded({ error: reason(error) }));
    return () => {
      current = false;
    };
  }, [shownVersion, read, readBytes]);

  useEffect(() => {
    if (book === null || host.current === null) return;
    const container = host.current;
    let disposed = false;
    import("./sheet-grid").then(({ mountGrid }) => {
      if (disposed) return;
      grid.current = mountGrid(container, univerDataOf(book.workbook), {
        position: position.current,
        rendered: () => setDrawn(book),
        changed: () => {
          const edited = grid.current !== null && editsOf(book.workbook, grid.current.cells()).length > 0;
          setChanged(edited);
          if (edited) hold((current) => current ?? book.version);
        },
      });
    }, (error: unknown) => setLoaded({ error: `the grid didn't load: ${reason(error)}` }));
    return () => {
      disposed = true;
      if (grid.current !== null) {
        position.current = grid.current.position();
        grid.current.dispose();
      }
      grid.current = null;
      setChanged(false);
    };
  }, [book, mounts]);

  const onScreen = book?.version ?? shownVersion;
  useEffect(() => shows({ version: onScreen, unsaved: changed }), [shows, onScreen, changed]);

  const shown = (): Sheet | null => {
    if (sheet === null || book === null || grid.current === null) return null;
    return { edits: [...sheet.edits, ...editsOf(book.workbook, grid.current.cells())] };
  };

  const drop = () => {
    setFailures([]);
    hold(null);
    remount((n) => n + 1);
  };

  const submit = async () => {
    const edited = shown();
    if (edited === null) return;
    setBusy(true);
    setFailures([]);
    try {
      const name = baseOf(shownVersion.id);
      await save({ id: shownVersion.id, version: shownVersion.version, files: { [name]: `${JSON.stringify(edited, null, 2)}\n` } });
      hold(null);
    } catch (error) {
      setFailures(reason(error).split("\n").map((line) => `Couldn't save: ${line}`));
    } finally {
      setBusy(false);
    }
  };

  const failure = loaded !== null && "error" in loaded ? loaded.error : null;
  return (
    <>
      <Presence>{failure !== null && (
        <motionElement.p {...presenceMotion} role="alert" className="artifact-refused">Couldn&apos;t open {shownVersion.title}: {failure}</motionElement.p>
      )}</Presence>
      <div className="artifact-edit-bar">
        <Button type="button" variant="ghost" size="sm" disabled={!changed || busy} onClick={() => void submit()}>Save</Button>
        <Button type="button" variant="ghost" size="sm" disabled={!changed || busy} onClick={drop}>Cancel</Button>
      </div>
      <Presence>{held !== null && !busy && newest.version > held.version && (
        <motionElement.div {...presenceMotion} role="status" className="artifact-edit-newer">
          <span>Version {newest.version} arrived while you edited version {held.version}. Your edits are kept.</span>
          <Button type="button" variant="ghost" size="sm" onClick={drop}>Discard edits and open version {newest.version}</Button>
        </motionElement.div>
      )}</Presence>
      <Presence>{failures.map((text) => (
        <motionElement.p key={text} {...presenceMotion} role="alert" className="artifact-refused artifact-edit-failure">{text}</motionElement.p>
      ))}</Presence>
      <div ref={host} aria-busy={!rendered} data-sheet-cells className="artifact-cells" />
    </>
  );
}
