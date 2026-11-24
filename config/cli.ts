#!/usr/bin/env node
// `botcube footprint [--files-access-point-mode <runtime|pool>] [--bot <bot.yaml>] <botcube.yaml>`: what that BotCube Config needs from its AWS account (ADR 0091).
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

const { main } = await import('./footprint-cli.ts');
process.exitCode = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
