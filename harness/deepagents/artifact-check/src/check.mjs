import { describe } from './describe.mjs';
import { checkDoc } from './doc.mjs';
import { checkEmail } from './email.mjs';
import { checkSheet } from './sheet.mjs';
import { checkDeck } from './slides.mjs';

const TYPES = {
  slides: { reads: /^project\/(?:deck\.json|slides\/[^/]+\.html)$/, check: checkDeck },
  doc: { reads: /^[^/]+\.md$/i, check: checkDoc },
  sheet: { reads: /^[^/]+\.sheet\.json$/, check: checkSheet },
  email: { reads: /^[^/]+\.email\.json$/, check: checkEmail },
};

function entry(type) {
  const found = Object.hasOwn(TYPES, type) ? TYPES[type] : undefined;
  if (found === undefined) throw new Error(`No checker for the Artifact Type ${type}`);
  return found;
}

export { describe };

export const checked = (type) => Object.hasOwn(TYPES, type);

export const reads = (type, path) => entry(type).reads.test(path);

export const check = (type, files) => entry(type).check(files);
