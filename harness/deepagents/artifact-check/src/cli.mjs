#!/usr/bin/env node
// `artifact-check slides <deck folder>`: prints {"errors": [...]} for the deck under that folder (its `project/`),
// exiting 3 when there are errors. `artifact-check rules`: prints the skill page's Slides rules table.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkDeck, describe } from './slides.mjs';
import { rulesTable } from './subset.mjs';

const [command, folder] = process.argv.slice(2);
if (command === 'rules') {
  process.stdout.write(rulesTable());
} else if (command === 'slides' && folder) {
  const files = {};
  const read = (path) => {
    for (const entry of readdirSync(join(folder, path), { withFileTypes: true })) {
      const name = `${path}/${entry.name}`;
      if (entry.isDirectory()) read(name);
      else if (name === 'project/deck.json' || /^project\/slides\/[^/]+\.html$/.test(name)) files[name] = readFileSync(join(folder, name), 'utf8');
    }
  };
  read('project');
  const errors = await checkDeck(files);
  process.stdout.write(`${JSON.stringify({ errors: errors.map((error) => ({ ...error, text: describe(error) })) })}\n`);
  // 3, not 1: Node exits 1 on an uncaught exception, which the harness must read as the checker failing.
  process.exitCode = errors.length === 0 ? 0 : 3;
} else {
  process.stderr.write('usage: artifact-check slides <deck folder> | artifact-check rules\n');
  process.exitCode = 2;
}
