#!/usr/bin/env node
import { registerHooks } from 'node:module';

// Node strips the seam's types but keeps its `.js` import specifiers, which name the `.ts` file beside them.
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

const { main } = await import('./commands.ts');
process.exitCode = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
