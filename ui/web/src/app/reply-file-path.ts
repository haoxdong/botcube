export function replyFilePath(value: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (
    /[\\?#]/.test(decoded) ||
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
  };
}
