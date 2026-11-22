import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { jsonSchemaCopies, jsonSchemas } from './schema.js';

const committed = Object.entries(jsonSchemas()).flatMap(([file, schema]) => [file, ...(jsonSchemaCopies[file] ?? [])].map((path) => [path, schema] as const));

it.each(committed)('commits %s as the schema emits it (regenerate: pnpm --filter botcube-config emit)', (file, schema) => {
  expect(JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'))).toEqual(schema);
});

it('lets a BotCube Config leave out every section', () => {
  expect(jsonSchemas()['botcube.schema.json']).toMatchObject({ additionalProperties: false });
});

type SchemaNode = { description?: string; properties?: Record<string, SchemaNode> };

it.each(['parking.automationUserAgents', 'services.credentialService.http.publicPaths', 'planUsage'])(
  '%s, a key with no standard, says what BotCube behaviour it owns',
  (path) => {
    const root = jsonSchemas()['botcube.schema.json'] as SchemaNode;
    const node = path.split('.').reduce<SchemaNode | undefined>((schema, key) => schema?.properties?.[key], root);
    expect(node?.description).toMatch(/^BotCube-owned: /);
  },
);
