import { format } from 'prettier';
// `node emit.ts`: writes the BotCube Config's JSON Schemas.
import { writeFileSync } from 'node:fs';
import './register-node-types.mjs';

const { jsonSchemaCopies, jsonSchemas } = await import('./schema.ts');

await Promise.all(Object.entries(jsonSchemas()).map(async ([file, schema]) => {
  const text = await format(JSON.stringify(schema), { parser: 'json' });
  for (const path of [file, ...(jsonSchemaCopies[file] ?? [])]) writeFileSync(new URL(path, import.meta.url), text);
}));

const { resolvedArtifacts } = await import('./resolved-artifacts.mjs');
for (const [path, contents] of Object.entries(resolvedArtifacts())) {
  writeFileSync(new URL(path, import.meta.url), contents);
}
