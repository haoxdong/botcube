import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { jsonSchemaCopies, jsonSchemas } from './schema.js';

const committed = Object.entries(jsonSchemas()).flatMap(([file, schema]) => [file, ...(jsonSchemaCopies[file] ?? [])].map((path) => [path, schema] as const));

it.each(committed)('commits %s as the schema emits it (regenerate: pnpm --filter botcube-deployment-config emit)', (file, schema) => {
  expect(JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))).toEqual(schema);
});

it('lets a Deployment Config leave out every section but its bot', () => {
  expect(jsonSchemas()['deployment-config.schema.json']).toMatchObject({ required: ['bot'], additionalProperties: false });
});
