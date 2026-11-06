/** The value a test expects to be there, or a failure naming what is missing. */
export function defined<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}
