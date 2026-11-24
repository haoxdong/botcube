import { format } from 'prettier';
// `node emit.ts`: writes the BotCube Config's JSON Schemas.
import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Node strips the schema's types but keeps its `.js` import specifiers, which name the `.ts` file beside them.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!/^\.\.?\/.*\.js$/.test(specifier)) throw error;
      return nextResolve(specifier.replace(/\.js$/, '.ts'), context);
    }
  },
});

const { jsonSchemaCopies, jsonSchemas } = await import('./schema.ts');

await Promise.all(Object.entries(jsonSchemas()).map(async ([file, schema]) => {
  const text = await format(JSON.stringify(schema), { parser: 'json' });
  for (const path of [file, ...(jsonSchemaCopies[file] ?? [])]) writeFileSync(new URL(path, import.meta.url), text);
}));

const { resolvedArtifacts } = await import('./resolved-artifacts.mjs');
for (const [path, contents] of Object.entries(resolvedArtifacts())) {
  writeFileSync(new URL(path, import.meta.url), contents);
}
