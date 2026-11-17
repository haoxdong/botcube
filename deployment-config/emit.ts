import { writeFileSync } from 'node:fs';
import { jsonSchemaCopies, jsonSchemas } from './schema.ts';

for (const [file, schema] of Object.entries(jsonSchemas())) {
  for (const path of [file, ...(jsonSchemaCopies[file] ?? [])]) writeFileSync(new URL(path, import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
}
