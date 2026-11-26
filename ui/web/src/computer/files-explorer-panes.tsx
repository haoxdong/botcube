// File Explorer's Details and Preview panes and its Properties dialog, from stock Fluent parts (ADR 0093).
import {
  Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, DrawerBody, DrawerHeader, DrawerHeaderTitle, InlineDrawer,
  makeStyles, mergeClasses, Text, tokens,
} from '@fluentui/react-components';
import { ArrowDownload20Regular, Dismiss20Regular } from '@fluentui/react-icons';
import { Fragment, type ReactNode } from 'react';
import { FilesChart, opensAsChart } from './files-chart';
import { ItemGlyph, Thumbnail } from './files-explorer-icons';
import { useExplorerStyles } from './files-explorer-nav';
import { PaneDivider, usePaneSize } from './files-explorer-resize';
import { dateText, kindOf, locationText, sizeIn, sizeText, typeText, type FilesItem, type Place } from './files-items';
import type { FileEntry } from './files-service';

const useStyles = makeStyles({
  facts: { display: 'grid', gridTemplateColumns: 'auto minmax(0, 1fr)', columnGap: tokens.spacingHorizontalM, rowGap: tokens.spacingVerticalXS },
  pane: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalM, paddingTop: tokens.spacingVerticalM },
  // Old and new content share one cell, so the one fades out over the other fading in.
  preview: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: tokens.spacingVerticalM, minHeight: '200px' },
});

/** What Properties and the Details pane describe: some of the open place's items, or the place itself. */
export type Subject = { items: readonly FilesItem[] } | { place: Place; items: readonly FilesItem[] };

type Described = { name: string; facts: [string, string][] };

/** The newest change among some items, as Modified, if there are any. */
function modified(items: readonly FilesItem[]): [string, string][] {
  const at = items.map(({ lastModified }) => lastModified).sort().at(-1);
  return at === undefined ? [] : [['Modified', dateText(at)]];
}

/** A place's name and facts: Home's recent files, or a folder. */
function placeFacts(place: Place, items: readonly FilesItem[], files: readonly FileEntry[]): Described {
  const size = place === null ? items.reduce((total, item) => total + sizeIn(files, item), 0) : files.filter(({ name }) => name.startsWith(place)).reduce((total, { size: bytes }) => total + bytes, 0);
  const name = place === null ? 'Home' : place === '' ? 'workspace' : (place.split('/').at(-2) ?? '');
  return {
    name,
    facts: [
      ['Type', place === null ? 'Recent files' : 'File folder'],
      ['Location', place === null || place === '' ? '—' : locationText(place)],
      ['Size', sizeText(size)],
      ['Contains', `${items.length} ${items.length === 1 ? 'item' : 'items'}`],
      ...modified(items),
    ],
  };
}

/** Several items' name and facts: their count, and their type and location where they share one. */
function severalFacts(items: readonly FilesItem[], files: readonly FileEntry[]): Described {
  const types = new Set(items.map(typeText));
  const locations = new Set(items.map(({ path }) => locationText(path)));
  return {
    name: `${items.length} items`,
    facts: [
      ['Type', types.size === 1 ? `All of type ${[...types].join('')}` : 'Multiple types'],
      ['Location', locations.size === 1 ? `All in ${[...locations].join('')}` : 'Multiple locations'],
      ['Size', sizeText(items.reduce((total, item) => total + sizeIn(files, item), 0))],
    ],
  };
}

/** A subject's name, and its facts as Properties lists them: Type, Location, Size and Modified. */
function factsOf(subject: Subject, files: readonly FileEntry[]): Described {
  if ('place' in subject) {
    const { place, items } = subject;
    return placeFacts(place, items, files);
  }
  const { items } = subject;
  const [only] = items;
  if (items.length !== 1 || only === undefined) return severalFacts(items, files);
  return {
    name: only.name,
    facts: [['Type', typeText(only)], ['Location', locationText(only.path)], ['Size', sizeText(sizeIn(files, only))], ['Modified', dateText(only.lastModified)]],
  };
}

function Facts({ facts }: { facts: readonly [string, string][] }) {
  const styles = useStyles();
  return (
    <div className={styles.facts}>
      {facts.map(([label, value]) => (
        <Fragment key={label}>
          <Text weight="semibold">{label}</Text>
          <Text wrap>{value}</Text>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * A pane beside the list: an inline drawer at the end, with its title and Close, and the divider before it that resizes
 * it. The size is the drawer's own, Fluent's size variable.
 */
function SidePane({ title, open, onClose, children }: { title: string; open: boolean; onClose: () => void; children: ReactNode }) {
  const explorer = useExplorerStyles();
  const { elementRef, handleRef } = usePaneSize({ variable: '--fui-Drawer--size', grow: 'start', min: 200, max: 560 });
  return (
    <>
      <PaneDivider label={`Resize ${title.toLowerCase()}`} handleRef={handleRef} className={mergeClasses(!open && explorer.hidden)} />
      <InlineDrawer ref={elementRef} open={open} position="end" aria-label={title}>
        <DrawerHeader>
          <DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss20Regular />} aria-label={`Close ${title.toLowerCase()}`} onClick={onClose} />}>
            {title}
          </DrawerHeaderTitle>
        </DrawerHeader>
        <DrawerBody>{children}</DrawerBody>
      </InlineDrawer>
    </>
  );
}

/** The Details pane: the selection's big icon or picture, name, type, size, modified and location; else the place's. */
export function DetailsPane({ open, subject, files, thumbnailUrl, onClose }: {
  open: boolean;
  subject: Subject;
  files: readonly FileEntry[];
  thumbnailUrl: (path: string) => Promise<string>;
  onClose: () => void;
}) {
  const styles = useStyles();
  const { name, facts } = factsOf(subject, files);
  const [first] = subject.items;
  // One item shows as itself; several as the first's icon; the place as a folder.
  const one = !('place' in subject) && subject.items.length === 1 ? first : undefined;
  const icon: FilesItem = 'place' in subject || first === undefined ? { name, path: '', lastModified: '', folder: true } : first;
  return (
    <SidePane title="Details pane" open={open} onClose={onClose}>
      <div className={styles.pane}>
        {/* Windows swaps the pane's picture straight away. */}
        <div key={one?.path ?? `icon ${icon.path}`}>
          {one === undefined ? <ItemGlyph item={icon} size={96} /> : <Thumbnail item={one} size={96} shown={open} thumbnailUrl={thumbnailUrl} />}
        </div>
        <Text weight="semibold" size={400} wrap>{name}</Text>
        <Facts facts={facts} />
      </div>
    </SidePane>
  );
}

/**
 * The Preview pane: the selected picture as itself, a chart live, any other file "No preview available." with its
 * Download; with nothing, or several, selected, what to select.
 */
export function PreviewPane({ open, file, thumbnailUrl, onDownload, onClose }: {
  open: boolean;
  /** The one file selected, if any. */
  file: FilesItem | null;
  thumbnailUrl: (path: string) => Promise<string>;
  onDownload: (path: string) => void;
  onClose: () => void;
}) {
  const styles = useStyles();
  const shows = file === null ? 'nothing' : kindOf(file) === 'image' ? 'picture' : opensAsChart(file.name) ? 'chart' : 'other';
  return (
    <SidePane title="Preview pane" open={open} onClose={onClose}>
      <div key={`${shows} ${file?.path ?? ''}`} className={styles.preview}>
        {file === null ? <Text>Select a file to preview.</Text>
          : shows === 'picture' ? <Thumbnail item={file} size={256} shown={open} thumbnailUrl={thumbnailUrl} />
          : shows === 'chart' ? <FilesChart file={file} fileUrl={thumbnailUrl} onDownload={onDownload} onClose={onClose} />
          : (
            <>
              <ItemGlyph item={file} size={96} />
              <Text>No preview available.</Text>
              <Button icon={<ArrowDownload20Regular />} onClick={() => onDownload(file.path)}>Download</Button>
            </>
          )}
      </div>
    </SidePane>
  );
}

/** Properties: a subject's name, type, location, size and modified, until OK. */
export function PropertiesDialog({ shown, files, onClose, onGone }: {
  /** The subject, and whether the dialog is open; it stays until its close motion has ended. */
  shown: { subject: Subject; open: boolean } | null;
  files: readonly FileEntry[];
  onClose: () => void;
  onGone: () => void;
}) {
  const { name, facts } = shown === null ? { name: '', facts: [] } : factsOf(shown.subject, files);
  return (
    <Dialog
      open={shown?.open === true}
      onOpenChange={(_, data) => { if (!data.open) onClose(); }}
      surfaceMotion={{ onMotionFinish: (_, { direction }) => { if (direction === 'exit') onGone(); } }}
    >
      <DialogSurface aria-label={`${name} Properties`}>
        <DialogBody>
          <DialogTitle>{`${name} Properties`}</DialogTitle>
          <DialogContent><Facts facts={facts} /></DialogContent>
          <DialogActions>
            <Button appearance="primary" onClick={onClose}>OK</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
