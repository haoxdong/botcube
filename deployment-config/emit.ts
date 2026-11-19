// `node emit.ts`: writes the Deployment Config's JSON Schemas.
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

for (const [file, schema] of Object.entries(jsonSchemas())) {
  for (const path of [file, ...(jsonSchemaCopies[file] ?? [])]) writeFileSync(new URL(path, import.meta.url), `${JSON.stringify(schema, null, 2)}\n`);
}
