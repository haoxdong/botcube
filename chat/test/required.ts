/** A value a test relies on, or a failure naming what is missing (ADR 0030). */
export function required<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`missing ${what}`);
  return value;
}
