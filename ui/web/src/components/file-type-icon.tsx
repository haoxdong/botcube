import { defaultStyles, FileIcon, type DefaultExtensionType } from 'react-file-icon';

/** A name's extension: the text after its last dot, lowercased; none ('') for a name without one, or a dotfile. */
export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** The types shown as their own picture rather than their type's icon, by extension. */
const IMAGES = new Set(['gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);

/** Whether a file, by its name, is an image: its own thumbnail in Files, the composer and once sent, inline in a reply. */
export const isImageName = (name: string) => IMAGES.has(fileExtension(name));

/**
 * Each label's colour by extension, as DESIGN.md gives it: `red` PDF and deck, `green` sheet, `blue` document, and
 * `text-muted` the rest.
 */
const COLOURED = new Map(
  Object.entries({ red: ['pdf', 'pptx'], green: ['xlsx', 'csv'], blue: ['docx'] })
    .flatMap(([colour, extensions]) => extensions.map((extension) => [extension, `var(--color-${colour})`] as const)),
);

/** Whether react-file-icon draws a glyph for an extension; an own key, so `constructor` and its kin are not one. */
function drawn(extension: string): extension is DefaultExtensionType {
  return Object.hasOwn(defaultStyles, extension);
}

/**
 * A file's type icon by its name, from react-file-icon: a folded page with its type's label and glyph.
 * Every colour is a design-system token in place of react-file-icon's own; the library writes them as fill attributes,
 * where `var()` does not resolve, so files.css's `.file-type-icon` rules paint each token's attribute with the token.
 */
export function FileTypeIcon({ name }: { name: string }) {
  const extension = fileExtension(name);
  const label = COLOURED.get(extension) ?? 'var(--color-text-muted)';
  return (
    // The cell or card around it names the file; FileIcon passes no attributes to its svg, so this hides it.
    <span className="file-type-icon" aria-hidden="true">
      <FileIcon
        extension={extension}
        type={drawn(extension) ? defaultStyles[extension].type : undefined}
        color="var(--color-white)"
        foldColor="var(--color-line)"
        labelColor={label}
        labelTextColor="var(--color-white)"
        glyphColor={label}
        // react-file-icon's sheen fades white into the page; on a white page it shows nothing.
        gradientColor="var(--color-white)"
        gradientOpacity={0}
        labelUppercase={false}
      />
    </span>
  );
}
