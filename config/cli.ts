#!/usr/bin/env node
import './register-node-types.mjs';

const { main } = await import('./commands.ts');
process.exitCode = main(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
