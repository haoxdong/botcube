const { existsSync, readFileSync } = require('node:fs');
const { basename } = require('node:path');
const { parseDocument } = require('yaml');
const Ajv2020 = require('ajv/dist/2020').default;
const schema = require('./botcube.schema.json');
const validate = new Ajv2020({ strict: false, validateFormats: false }).compile(schema);


function readYaml(path, source, ErrorType) {
  if (!existsSync(path)) throw new ErrorType(`${source}: no file`);
  return parseYaml(readFileSync(path, 'utf8'), source, ErrorType);
}

function parseYaml(text, source, ErrorType = Error) {
  const document = parseDocument(text, { version: '1.2', uniqueKeys: true });
  if (document.errors.length) throw new ErrorType(`${source}: not YAML 1.2: ${document.errors.map(error => error.message).join('; ')}`);
  if (document.directives.yaml.version !== '1.2') throw new ErrorType(`${source}: expected YAML 1.2`);
  return document.toJS();
}

function readConfigSource(path, ErrorType = Error) {
  const source = `BotCube Config ${path}`;
  if (basename(path) === 'deployment-config.json') throw new ErrorType(`${source}: deployment-config.json: renamed to botcube.yaml`);
  const value = readYaml(path, source, ErrorType);
  if (value && typeof value === 'object') {
    for (const [key, replacement] of Object.entries(schema['x-renamed-keys'])) {
      if (Object.hasOwn(value, key)) throw new ErrorType(`${source}: ${key}: renamed to ${replacement}`);
    }
  }
  return value;
}

function readConfig(path) {
  const ErrorType = Error;
  const value = readConfigSource(path);
  if (validate(value)) return value;
  throw new ErrorType(validate.errors.map(error => {
    const field = [...error.instancePath.split('/').filter(Boolean), ...(error.params.additionalProperty ? [error.params.additionalProperty] : [])].join('.') || '(root)';
    return `BotCube Config ${path}: ${field}: ${error.message}`;
  }).join('\n'));
}

module.exports = { readConfigSource, readConfig, parseYaml };
