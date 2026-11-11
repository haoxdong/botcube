/**
 * html-to-docx's browser build, as the Doc's Word Export calls it. Typed here, not from the package's own types, which
 * bring Node's into the app.
 */
declare module "@turbodocx/html-to-docx/dist/html-to-docx.browser.esm.js" {
  type Options = { title?: string; font?: string; table?: { row?: { cantSplit?: boolean } } };
  export default function htmlToDocx(html: string, header: string | null, options?: Options): Promise<Blob | ArrayBuffer>;
}
