import { resolvedPython } from './resolved-python.mjs';
import { FORMAT_VERSION, resolveConfig, resolvedJson } from './resolved.ts';
import { sectionDefaults } from './schema.ts';

const python = './src/botcube_config/';

export function resolvedArtifacts() {
  return {
    [python + 'generated/resolved_config_types.py']: resolvedPython(FORMAT_VERSION),
    [python + 'resolved-empty.json']: resolvedJson(resolveConfig(sectionDefaults())),
  };
}
