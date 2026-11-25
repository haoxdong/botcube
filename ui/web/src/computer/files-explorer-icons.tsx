// File Explorer's item icons and picture thumbnails, from stock Fluent parts (ADR 0093).
import { Image, makeStyles, mergeClasses } from '@fluentui/react-components';
import {
  Code20Regular, CodeRegular, DataLineRegular, Document20Regular, DocumentRegular, DocumentText20Regular, DocumentTextRegular, Folder20Filled,
  FolderFilled, Image20Regular, ImageRegular, type FluentIcon,
} from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { fileExtension, FileTypeIcon } from '../components/file-type-icon';
import { isFigureName } from '../components/plotly-figure';
import { kindOf, type FilesItem } from './files-items';
import { FOLDER } from './windows-window';

const TEXT = new Set(['md', 'txt']);
const CODE = new Set(['js', 'json', 'py', 'ts']);

/** An item's icon at the details view's 20px. */
export function ItemIcon({ item }: { item: FilesItem }) {
  const kind = kindOf(item);
  if (kind === 'folder') return <Folder20Filled color={FOLDER} />;
  if (kind === 'image') return <Image20Regular />;
  const extension = fileExtension(item.name);
  if (TEXT.has(extension)) return <DocumentText20Regular />;
  return CODE.has(extension) ? <Code20Regular /> : <Document20Regular />;
}

/** An item's icon drawn at any size: the unsized icons are 1em square. */
function glyphOf(item: FilesItem): FluentIcon {
  const kind = kindOf(item);
  if (kind === 'folder') return FolderFilled;
  if (kind === 'image') return ImageRegular;
  if (isFigureName(item.name)) return DataLineRegular;
  const extension = fileExtension(item.name);
  if (TEXT.has(extension)) return DocumentTextRegular;
  return CODE.has(extension) ? CodeRegular : DocumentRegular;
}

/** The sizes Explorer draws icons at: Extra large 256, Large 96, Medium 48, and 32, 16 for the rest. */
export type IconSize = 16 | 32 | 48 | 96 | 256;

const useStyles = makeStyles({
  16: { fontSize: '16px', width: '16px', height: '16px' },
  32: { fontSize: '32px', width: '32px', height: '32px' },
  48: { fontSize: '48px', width: '48px', height: '48px' },
  96: { fontSize: '96px', width: '96px', height: '96px' },
  256: { fontSize: '256px', width: '256px', height: '256px' },
  stack: { display: 'grid', placeItems: 'center', flexShrink: 0 },
  // A type icon's page is 40 by 48: at the box's height, five sixths of its width.
  page: { display: 'grid', placeItems: 'center', flexShrink: 0, '& > .file-type-icon': { width: '83.333%' } },
  layer: { gridArea: '1 / 1' },
  unseen: { visibility: 'hidden' },
  hidden: { display: 'none' },
});

/**
 * An item's icon at a size. From 32px a file is its type's page, coloured as the chat's Files draws it, as Windows draws
 * a type's icon at these sizes; smaller, and for a folder, it is the line glyph Details uses.
 */
export function ItemGlyph({ item, size, className }: { item: FilesItem; size: IconSize; className?: string }) {
  const styles = useStyles();
  if (size >= 32 && !item.folder) return <span aria-hidden="true" className={mergeClasses(styles.page, styles[size], className)}><FileTypeIcon name={item.name} /></span>;
  const Glyph = glyphOf(item);
  return <Glyph aria-hidden="true" className={mergeClasses(styles[size], className)} {...(item.folder ? { color: FOLDER } : {})} />;
}

/**
 * An item's icon, or for a picture its own picture from the short-lived URL `thumbnailUrl` gives for its path: its type
 * icon until the picture has loaded, and still its icon when the URL or the picture fails. A picture loads only once it
 * is `shown`, so a view that is not on screen asks for no URLs.
 */
export function Thumbnail({ item, size, shown, thumbnailUrl }: {
  item: FilesItem;
  size: IconSize;
  shown: boolean;
  thumbnailUrl: (path: string) => Promise<string>;
}) {
  const styles = useStyles();
  const picture = kindOf(item) === 'image';
  // The URL of the item's picture, and whether it has loaded: null until asked, then 'failed' for good.
  const [source, setSource] = useState<{ path: string; url: string | null; loaded: boolean } | null>(null);
  const current = source?.path === item.path ? source : null;
  useEffect(() => {
    if (!picture || !shown || current !== null) return;
    let live = true;
    const path = item.path;
    thumbnailUrl(path).then(
      (url) => { if (live) setSource({ path, url, loaded: false }); },
      () => { if (live) setSource({ path, url: null, loaded: false }); },
    );
    return () => { live = false; };
  }, [picture, shown, current, item.path, thumbnailUrl]);
  const url = current?.url ?? null;
  const ready = url !== null && current?.loaded === true;
  return (
    <span className={mergeClasses(styles.stack, styles[size])} aria-hidden="true">
      <ItemGlyph item={item} size={size} className={mergeClasses(styles.layer, ready && styles.hidden)} />
      <Image
        {...(url === null ? {} : { src: url })}
        alt=""
        fit="contain"
        loading="lazy"
        draggable={false}
        data-loading={ready ? undefined : true}
        className={mergeClasses(styles.layer, styles[size], url === null ? styles.hidden : !ready && styles.unseen)}
        onLoad={() => setSource((was) => (was?.url === url && url !== null ? { ...was, loaded: true } : was))}
        onError={() => setSource((was) => (was?.url === url ? { path: item.path, url: null, loaded: false } : was))}
      />
    </span>
  );
}
