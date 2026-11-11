// Checks an Email's Source, its one draft file, against the email format (email-schema.mjs); `htmlBody` holds only
// what the Email Viewer's editor holds (email-html.mjs). Whether an attachment's File is there is the publish's to
// check: the checker reads only the draft.
import { HtmlValidate, Rule, StaticConfigLoader } from 'html-validate';

import { EMAIL_ELEMENTS, EMAIL_HREF, NEAREST_EMAIL } from './email-html.mjs';
import { EMAIL_SCHEMA, schemaErrors } from './email-schema.mjs';

/** @typedef {import('./check.mjs').CheckError} EmailError */

/**
 * Every error in an Email's Source, given its one draft file by its name. An empty list means it may be saved.
 * @param {Record<string, string>} files
 * @returns {Promise<EmailError[]>}
 */
export async function checkEmail(files) {
  const drafts = Object.entries(files);
  if (drafts.length !== 1) {
    return [{ file: drafts.map(([name]) => name).join(', ') || 'draft', element: 'Source', message: `holds ${drafts.length} drafts`, nearest: 'one <name>.email.json file' }];
  }
  const [[file, text]] = drafts;
  return checkDraft(file, text);
}

async function checkDraft(file, text) {
  let draft;
  try {
    draft = JSON.parse(text);
  } catch (error) {
    return [{ file, element: 'draft', message: `is not JSON: ${error.message}`, nearest: EMAIL_SCHEMA.nearest }];
  }
  const errors = schemaErrors(draft)
    .map((error) => ({ file, element: elementOf(error.instanceLocation) || 'draft', ...said(error) }));
  if (typeof draft?.htmlBody === 'string') errors.push(...await checkBody(file, draft.htmlBody));
  return errors;
}

function said({ keyword, keywordLocation, instanceLocation, error }) {
  const schema = subschema(keywordLocation.split('/').slice(1, -1));
  if (keyword === 'required') {
    const missing = /"([^"]+)"/.exec(error)?.[1] ?? '';
    return { message: `has no ${missing}`, nearest: schema.properties[missing].nearest };
  }
  if (keyword === 'enum') {
    const name = decodeURIComponent(instanceLocation.slice(instanceLocation.lastIndexOf('/') + 1));
    return { message: 'is not a draft field', nearest: schema.nearestFor?.[name] ?? schema.nearest };
  }
  if (keyword === 'type') {
    const [, found, wanted] = /"(\w+)".*"(\w+)"/.exec(error) ?? [];
    return { message: `is of type ${found}, not ${wanted}`, nearest: schema.nearest };
  }
  return { message: 'is not in the allowed form', nearest: schema.nearest };
}

function subschema(path) {
  return path.reduce((schema, key) => schema[key], EMAIL_SCHEMA);
}

/** `#/attachments/1/file` as the agent reads it: `attachments[1].file`. */
function elementOf(location) {
  return location.split('/').slice(1).map(decodeURIComponent)
    .reduce((element, key) => (/^\d+$/.test(key) ? `${element}[${key}]` : element ? `${element}.${key}` : key), '');
}

const sinks = new Map();
let runs = 0;

class EmailBody extends Rule {
  setup() {
    this.on('dom:ready', ({ document, source }) => sinks.get(source.filename)?.(document.root));
  }
}

const bodies = new HtmlValidate(new StaticConfigLoader({
  root: true,
  plugins: [{ name: 'email', rules: { 'email/body': EmailBody } }],
  rules: {
    'email/body': 'error', 'close-order': 'error', 'close-attr': 'error', 'no-dup-attr': 'error', 'void-content': 'error',
    'attr-delimiter': 'error',
  },
}));

async function checkBody(file, html) {
  const errors = [];
  const name = `htmlBody-${runs++}`;
  const report = (element, message, nearest) => errors.push({ file, element: `htmlBody ${element}`, message, nearest });
  sinks.set(name, (root) => walkBody(root, report));
  try {
    const result = await bodies.validateString(html, name);
    for (const { messages } of result.results) {
      for (const message of messages) {
        if (message.ruleId === 'email/body') continue;
        report(message.selector ? `<${message.selector}>` : 'markup', `${message.message.replace(/\.$/, '')} (line ${message.line}, column ${message.column})`, 'well-formed markup: close each element where it opened');
      }
    }
  } finally {
    sinks.delete(name);
  }
  return errors;
}

const ALLOWED = Object.keys(EMAIL_ELEMENTS).map((tag) => `<${tag}>`).join(' ');
const BLOCK_PARENTS = new Set([undefined, 'li', 'blockquote']);

function walkBody(root, report) {
  const visit = (node, parent) => {
    const tag = node.tagName;
    const allowed = EMAIL_ELEMENTS[tag];
    if (allowed === undefined) {
      report(`<${tag}>`, 'is not an element the email editor holds, so the panel would drop it', NEAREST_EMAIL[tag] ?? `one of ${ALLOWED}`);
      return;
    }
    for (const { key } of node.attributes) {
      if (allowed.attributes.includes(key)) continue;
      report(`<${tag} ${key}>`, 'is not an attribute the email editor holds', key === 'style' ? NEAREST_EMAIL.style_attribute : NEAREST_EMAIL.attribute);
    }
    if (tag === 'a' && !EMAIL_HREF.test(node.getAttributeValue('href') ?? '')) {
      report('<a href>', 'is not a link the email editor keeps', 'href="https://…", "mailto:…" or "tel:…"');
    }
    checkPlace(node, allowed.kind, parent, report);
    for (const child of node.childElements) visit(child, tag);
  };
  for (const node of root.childElements) visit(node, undefined);
}

function checkPlace(node, kind, parent, report) {
  const tag = node.tagName;
  if (kind === 'item' && EMAIL_ELEMENTS[parent]?.kind !== 'list') report(`<${tag}>`, `is inside ${parent ? `a <${parent}>` : 'no list'}`, 'an <li> inside a <ul> or an <ol>');
  if ((kind === 'block' || kind === 'list') && !BLOCK_PARENTS.has(parent)) report(`<${tag}>`, `is inside a <${parent}>`, `a <${tag}> on its own, or inside an <li> or a <blockquote>`);
  const loose = (child) => (child.nodeType === 3 && child.textContent.trim() !== '') || (child.nodeType === 1 && child.tagName !== 'li');
  if (kind === 'list' && node.childNodes.some(loose)) report(`<${tag}>`, 'holds something other than <li>', `<${tag}><li><p>…</p></li></${tag}>`);
}
