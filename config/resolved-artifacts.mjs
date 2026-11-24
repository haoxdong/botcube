import { readFileSync } from 'node:fs';
import { resolvedPython } from './resolved-python.mjs';
import { FORMAT_VERSION, resolveConfig, resolvedJson } from './resolved.ts';
import { sectionDefaults } from './schema.ts';

const credential = '../credential-service/src/botcube_credential_service/';
const harness = '../harness/deepagents/src/botcube_harness_deepagents/';

export function resolvedArtifacts() {
  const types = resolvedPython(FORMAT_VERSION);
  const empty = resolvedJson(resolveConfig(sectionDefaults()));
  const reader = readFileSync(new URL(credential + 'resolved_config.py', import.meta.url), 'utf8');
  return {
    [credential + 'generated/resolved_config_types.py']: types,
    [harness + 'generated/resolved_config_types.py']: types,
    [credential + 'resolved-empty.json']: empty,
    [harness + 'resolved-empty.json']: empty,
    [harness + 'resolved_config.py']: reader,
  };
}
