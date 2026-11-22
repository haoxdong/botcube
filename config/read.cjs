const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { parseDocument } = require('yaml');
const { fillName } = require('./names.cjs');
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

/** Where `value` holds the key at the dotted `path`, whatever its value: `**.key` finds it at any depth, the first in document order. */
function heldKey(value, path) {
  if (path.startsWith('**.')) return deepKey(value, path.slice(3), []);
  const keys = path.split('.');
  const parent = keys.slice(0, -1).reduce((node, key) => (node !== null && typeof node === 'object' ? node[key] : undefined), value);
  return parent !== null && typeof parent === 'object' && Object.hasOwn(parent, keys.at(-1)) ? path : undefined;
}

function deepKey(value, key, at) {
  if (value === null || typeof value !== 'object') return undefined;
  if (!Array.isArray(value) && Object.hasOwn(value, key)) return [...at, key].join('.');
  for (const [name, child] of Object.entries(value)) {
    const found = deepKey(child, key, [...at, name]);
    if (found) return found;
  }
  return undefined;
}

function readConfigSource(path, ErrorType = Error) {
  const source = `BotCube Config ${path}`;
  if (basename(path) === 'deployment-config.json') throw new ErrorType(`${source}: deployment-config.json: renamed to botcube.yaml`);
  const value = readYaml(path, source, ErrorType);
  if (value && typeof value === 'object') {
    for (const [key, replacement] of Object.entries(schema['x-renamed-keys'])) {
      const held = heldKey(value, key);
      if (held) throw new ErrorType(`${source}: ${held}: renamed to ${replacement}`);
    }
  }
  return value;
}

function readConfig(path) {
  const ErrorType = Error;
  const value = readConfigSource(path);
  if (validate(value)) return value;
  throw new ErrorType(validate.errors.map(error => {
    const key = error.params.additionalProperty ?? error.params.missingProperty;
    const field = [...error.instancePath.split('/').filter(Boolean), ...(key ? [key] : [])].join('.') || '(root)';
    return `BotCube Config ${path}: ${field}: ${error.keyword === 'required' ? `'${key}' is a required property` : error.message}`;
  }).join('\n'));
}

/** The origins CORS allows: domains.web and its aliases; without domains, undefined. */
function webOrigins(config) {
  return config.domains ? [config.domains.web, ...(config.domains.webAliases ?? [])] : undefined;
}

const valueAt = (value, path) => path.split('.').reduce((node, key) => (node === undefined || node === null ? undefined : node[key]), value);

function setAt(root, keys, value) {
  const parent = keys.slice(0, -1).reduce((node, key, index) => {
    node[key] ??= /^\d+$/.test(keys[index + 1]) ? [] : {};
    return node[key];
  }, root);
  parent[keys.at(-1)] = value;
}

/**
 * The retired deploy-root `file` the BotCube Config at `configPath` stands for, built from the schema's x-retired-files
 * map, with a file path given relative to `repositoryRoot`.
 */
function deploymentFile(config, file, { configPath, repositoryRoot = resolve(__dirname, '..') }) {
  const fields = schema['x-retired-files'][file];
  if (!fields) throw new Error(`${file}: not a retired deploy-root file`);
  const { name } = config;
  const filled = template => fillName(template, name);
  const sourced = source => {
    if (source.when && !valueAt(config, source.when)) return undefined;
    if ('value' in source) return source.value;
    if ('derived' in source) return filled(source.derived);
    if ('file' in source) {
      const given = valueAt(config, source.file);
      return given === undefined ? undefined : relative(repositoryRoot, resolve(dirname(configPath), given));
    }
    const found = valueAt(config, source.path);
    if (found !== undefined && source.each) return found.map(item => Object.fromEntries(Object.entries(source.each).map(([field, from]) => [field, item[from]])));
    if (found !== undefined && source.as === 'hostname') return new URL(found).hostname;
    if (found !== undefined && source.as === 'list') return [found];
    if (found !== undefined) return found;
    return typeof source.default === 'string' ? filled(source.default) : source.default;
  };
  const entries = Object.entries(fields);
  const built = /^\d/.test(entries[0][0]) ? [] : {};
  for (const [field, source] of entries) {
    const value = sourced(source);
    if (value === undefined) continue;
    if (source.spread) setAt(built, field.split('.'), { ...valueAt(built, field), ...value });
    else setAt(built, field.split('.'), value);
  }
  return built;
}

/** Where a retired file's field went: the botcube.yaml key its Source names, or why none does. */
function replacement(source) {
  if (!source) return 'no botcube.yaml key; delete it';
  if ('derived' in source) return 'derived from botcube.yaml name';
  if ('value' in source) return "BotCube's own value; delete it";
  return `botcube.yaml ${'file' in source ? source.file : source.path}`;
}

/** Each leaf of a JSON value, as its dotted path; an empty object or list is a leaf. */
function leaves(value, path = []) {
  const entries = value !== null && typeof value === 'object' ? Object.entries(value) : [];
  return entries.length ? entries.flatMap(([key, child]) => leaves(child, [...path, key])) : [path.join('.')];
}

/**
 * The migration error lines of a retired file held in a deploy root: one per field it holds, naming the botcube.yaml
 * key that replaced it, from the schema's x-retired-files map. A field the map covers in part is named down to the
 * first key the map does not hold.
 */
function retiredFileErrors(deployRoot, file, held) {
  const fields = schema['x-retired-files'][file];
  const mapped = Object.keys(fields);
  const named = [];
  const holds = prefix => mapped.some(each => each === prefix || each.startsWith(`${prefix}.`));
  for (const leaf of leaves(held)) {
    const keys = leaf.split('.');
    const covering = mapped.filter(field => leaf === field || leaf.startsWith(`${field}.`)).sort((a, b) => b.length - a.length)[0];
    const unmapped = keys.findIndex((_, index) => !holds(keys.slice(0, index + 1).join('.')));
    const field = covering ?? (unmapped === -1 ? leaf : keys.slice(0, unmapped + 1).join('.'));
    if (!named.includes(field)) named.push(field);
  }
  return [
    `Deploy root ${deployRoot}: ${file} is retired: botcube.yaml beside the deploy root replaces it; move each field to its key there, then delete the file`,
    ...named.map(field => `Deploy root ${deployRoot}: ${file}: ${field}: ${replacement(fields[field])}`),
  ];
}

/** A configuration file, by its name: JSON, YAML, TOML, INI or an env file. */
const CONFIGURATION = /(\.(json|ya?ml|toml|ini|cfg|conf|env)|^\.env(\..*)?)$/;
/** Build manifests: package and lock files, tsconfig, pyproject, and a CDK app's cdk.json and its context cache. */
const MANIFEST = /^(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(\.[\w-]+)?\.json|pyproject\.toml|uv\.lock|cdk\.json|cdk\.context\.json)$/;
/**
 * The files a bot directory itself may hold beside its build manifests: its BotCube Config, the Bot Image's bot settings,
 * and the latency budgets, a deploy-root asset.
 */
const BOT_DIRECTORY_FILES = new Set(['botcube.yaml', 'bot.yaml', 'latency-budgets.json']);
/** Build output and dependencies, which no one writes by hand. */
const BUILT = new Set(['node_modules', 'cdk.out', 'dist', '__pycache__']);

/** The configuration files under `dir`, relative to it; a directory holding a Dockerfile or a browser extension's manifest.json is an image's build context, all source. */
function configurationFiles(dir, prefix = '') {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  if (prefix && entries.some(entry => entry.isFile() && (entry.name === 'Dockerfile' || entry.name === 'manifest.json'))) return [];
  return entries.flatMap(entry => {
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory()) return entry.name.startsWith('.') || BUILT.has(entry.name) ? [] : configurationFiles(join(dir, entry.name), `${path}/`);
    return CONFIGURATION.test(entry.name) && !MANIFEST.test(entry.name) ? [path] : [];
  });
}

/**
 * Every error of a bot directory against one config, botcube.yaml plus the images it names: each retired
 * file its deploy root still holds, field by field, then each other configuration file in the bot directory itself or
 * anywhere in its deploy root. Build manifests and images' build contexts may stay; nothing else may.
 */
function botDirectoryErrors(botDirectory, deployRoot = join(botDirectory, 'deploy')) {
  const retired = Object.keys(schema['x-retired-files']);
  const errors = retired.filter(file => existsSync(join(deployRoot, file)))
    .flatMap(file => retiredFileErrors(deployRoot, file, JSON.parse(readFileSync(join(deployRoot, file), 'utf8'))));
  const own = existsSync(botDirectory) ? readdirSync(botDirectory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))
    .filter(entry => entry.isFile() && CONFIGURATION.test(entry.name) && !MANIFEST.test(entry.name) && !BOT_DIRECTORY_FILES.has(entry.name))
    .map(entry => join(botDirectory, entry.name)) : [];
  const inDeployRoot = existsSync(deployRoot) ? configurationFiles(deployRoot).filter(file => !retired.includes(file)).map(file => join(deployRoot, file)) : [];
  return [
    ...errors,
    ...[...own, ...inDeployRoot].map(file => `Bot directory ${botDirectory}: ${relative(botDirectory, file)}: a configuration file; a deployment is botcube.yaml plus the images it names, so move its values into botcube.yaml, or into bot.yaml in the Bot Image, then delete the file`),
  ];
}

/** Fails, naming every error, unless the bot directory holds one config: botcube.yaml plus the images it names. */
function checkBotDirectory(botDirectory, deployRoot) {
  const errors = botDirectoryErrors(botDirectory, deployRoot);
  if (errors.length) throw new Error(errors.join('\n'));
}

/**
 * The BotCube Config beside a deploy root, read once, and each of the deploy root's files built from it (`file`). It
 * fails while the deploy root still holds a retired file, or its bot directory any other configuration file.
 */
function deployRootFiles(deployRoot, { repositoryRoot } = {}) {
  const botDirectory = join(deployRoot, '..');
  checkBotDirectory(botDirectory, deployRoot);
  const configPath = join(botDirectory, 'botcube.yaml');
  const config = existsSync(configPath) ? readConfig(configPath) : {};
  const file = name => {
    if (!config.name) throw new Error(`${join(deployRoot, name)}: BotCube Config ${configPath} names no deployment`);
    return deploymentFile(config, name, { configPath, ...(repositoryRoot ? { repositoryRoot } : {}) });
  };
  return { config, file };
}

/** A deploy root's `file`, built from the BotCube Config beside it, as {@link deployRootFiles} builds it. */
function deployRootFile(deployRoot, file, options) {
  return deployRootFiles(deployRoot, options).file(file);
}

/** The IAM resource a Credential Source's `secretId` grants: its ARN as given, or a name's every ARN in the reader's own account and region. */
function secretResource(secretId, { partition, region, account }) {
  return secretId.startsWith('arn:') ? secretId : `arn:${partition}:secretsmanager:${region}:${account}:secret:${secretId}-??????`;
}

module.exports = { secretResource, readConfigSource, readConfig, parseYaml, webOrigins, deploymentFile, deployRootFiles, deployRootFile, botDirectoryErrors, checkBotDirectory };

// `node read.cjs <deploy root> <file> [repository root]` prints the deploy root's file as JSON, for a shell or workflow step.
if (require.main === module) {
  const [deployRoot, file, repositoryRoot] = process.argv.slice(2);
  if (!deployRoot || !file) throw new Error('usage: node read.cjs <deploy root> <file> [repository root]');
  process.stdout.write(`${JSON.stringify(deployRootFile(deployRoot, file, repositoryRoot ? { repositoryRoot: resolve(repositoryRoot) } : {}))}\n`);
}
