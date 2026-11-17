#!/usr/bin/env node
// `artifact-check <type> <Source> [name]`: prints {"errors": [...]}, exiting 3 when there are errors. The Source is a
// folder, or one file, which the checker reads by `name` when given, else by its own file name.
// `artifact-check rules`: prints the skill page's Slides rules table.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import { check, checked, describe, reads } from './check.mjs';
import { rulesTable } from './subset.mjs';

const [command, folder, named] = process.argv.slice(2);
if (command === 'rules') {
  process.stdout.write(rulesTable());
} else if (command !== undefined && checked(command) && folder) {
  const files = {};
  if (statSync(folder).isFile()) {
    const name = named ?? basename(folder);
    if (reads(command, name)) files[name] = readFileSync(folder, 'utf8');
  } else {
    for (const entry of readdirSync(folder, { recursive: true, withFileTypes: true })) {
      const name = relative(folder, join(entry.parentPath, entry.name)).split('\\').join('/');
      if (entry.isFile() && reads(command, name)) files[name] = readFileSync(join(folder, name), 'utf8');
    }
  }
  const errors = await check(command, files);
  process.stdout.write(`${JSON.stringify({ errors: errors.map((error) => ({ ...error, text: describe(error) })) })}\n`);
  // 3, not 1: Node exits 1 on an uncaught exception, which the harness must read as the checker failing.
  process.exitCode = errors.length === 0 ? 0 : 3;
} else {
  process.stderr.write('usage: artifact-check <type> <Source folder or file> [name] | artifact-check rules\n');
  process.exitCode = 2;
}
