export function replyFilePath(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (
    value.includes('#') ||
    /[\\?]/.test(decoded) ||
    [...decoded].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    decoded.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(decoded)
  )
    return null;
  const absolute = value.startsWith('/');
  const segments = (decoded.startsWith('/') ? decoded.slice(1) : decoded).split(
    '/'
  );
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  )
    return null;
  if (!absolute && (segments.length !== 1 || !/^[^@/]+\.[^./]+$/.test(decoded)))
    return null;
  return absolute ? value : `/${value}`;
}

type FileNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: FileNode[];
};

export function rehypeReplyFiles() {
  return function normalize(node: FileNode) {
    const property =
      node.tagName === 'img' ? 'src' : node.tagName === 'a' ? 'href' : null;
    if (property && typeof node.properties?.[property] === 'string') {
      const path = replyFilePath(node.properties[property]);
      if (path) node.properties[property] = path;
      else if (!/^[a-z][a-z\d+.-]*:/i.test(node.properties[property]))
        node.properties[property] = '';
    }
    node.children?.forEach(normalize);
    if (node.children) node.children = node.children.flatMap(asFileCards);
  };
}

/**
 * A block made only of links to files in Files, as those links marked `data-file-card` for ReplyFileLink to show as
 * the files' cards, in order: a paragraph of such links and line breaks, or a list whose every item is one such link.
 * The links take the block's place, so a card's blocks never sit inside a `<p>` or behind a bullet. A block with any
 * other text or link stays as it is.
 */
function asFileCards(node: FileNode): FileNode[] {
  const links = fileLinks(node);
  return links
    ? links.map((link) => ({
        ...link,
        properties: { ...link.properties, dataFileCard: '' },
      }))
    : [node];
}

function fileLinks(node: FileNode): FileNode[] | null {
  const content = node.children?.filter((child) => !blank(child)) ?? [];
  const links =
    node.tagName === 'p'
      ? content.filter((child) => child.tagName !== 'br')
      : node.tagName === 'ul' || node.tagName === 'ol'
        ? content.map((item) =>
            item.tagName === 'li' ? soleChild(item) : undefined
          )
        : [];
  return links.length > 0 && links.every(isFileLink) ? links : null;
}

/** A list item's one child, looking through the paragraph a loose list wraps it in. */
function soleChild(node: FileNode): FileNode | undefined {
  const content = node.children?.filter((child) => !blank(child));
  const only = content?.length === 1 ? content[0] : undefined;
  return only?.tagName === 'p' ? soleChild(only) : only;
}

const blank = (node: FileNode) =>
  node.type === 'text' && !/\S/.test(node.value ?? '');

const isFileLink = (node: FileNode | undefined): node is FileNode =>
  node?.tagName === 'a' &&
  typeof node.properties?.href === 'string' &&
  replyFilePath(node.properties.href) !== null;
