/** Omit an unspecified physical name so CDK retains its existing default. */
export function optionalPhysicalName<K extends string>(property: K, value: string | undefined): Partial<Record<K, string>> {
  return value === undefined ? {} : { [property]: value } as Record<K, string>;
}
