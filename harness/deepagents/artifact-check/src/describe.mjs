/** One error as the agent reads it: `file:line:col element — what is wrong. Nearest: the allowed form.` */
export function describe({ file, line, column, element, message, nearest }) {
  return `${file}${line === undefined ? '' : `:${line}:${column}`}${element ? ` ${element}` : ''} — ${message}. Nearest: ${nearest}.`;
}
