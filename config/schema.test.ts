import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { resolvedArtifacts } from './resolved-artifacts.mjs';
import { jsonSchemas } from './schema.js';

const committed = Object.entries(jsonSchemas());

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

it('ships emitted resolved types and section defaults in the Python package', () => {
  for (const [path, contents] of Object.entries(resolvedArtifacts())) {
    expect(readFileSync(new URL(path, import.meta.url), 'utf8'), path).toBe(contents);
  }
});
