const { createHash } = require('node:crypto');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { parseYaml } = require('botcube-config/read');

module.exports = function botSettingsModule(file) {
  const text = JSON.stringify(parseYaml(readFileSync(file, 'utf8'), file));
  const hash = createHash('sha256').update(text).digest('hex');
  const directory = path.join(path.dirname(file), '.tmp');
  mkdirSync(directory, { recursive: true });
  const generated = path.join(directory, `bot-settings-${hash}.json`);
  writeFileSync(generated, text);
  return generated;
};
