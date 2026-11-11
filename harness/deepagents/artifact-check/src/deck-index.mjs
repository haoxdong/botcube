// Checks a Slides deck's index, `project/deck.json`: its title, its order of slide ids against the slide files
// written, its sections and its typefaces (the Artifacts spec, Checker). slides.mjs checks the slides themselves.
import { LIMITS, SLIDE_ID } from './subset.mjs';

const FILE = 'project/deck.json';
/** @returns {import('./slides.mjs').SlideError} */
const error = (element, message, nearest) => ({ file: FILE, element, message, nearest });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Every error in `project/deck.json`, given its text and the ids of the slide files written.
 * @param {string} text
 * @param {Set<string>} written
 * @returns {import('./slides.mjs').SlideError[]}
 */
export function checkIndex(text, written) {
  let deck;
  try {
    deck = JSON.parse(text);
  } catch (failure) {
    return [error('deck.json', `is not JSON (${failure.message})`, '{"title": "…", "order": ["cover", …], "sections": {…}, "faces": {}}')];
  }
  if (!isObject(deck)) return [error('deck.json', 'is not an object', '{"title": "…", "order": […]}')];
  const errors = [];
  if (typeof deck.title !== 'string') errors.push(error('title', 'is not a string', '"title": "the deck\'s name"'));
  if (!Array.isArray(deck.order)) {
    errors.push(error('order', 'is not a list of slide ids', '"order": ["cover", "plan"]'));
    return errors;
  }
  const seen = new Set();
  errors.push(...orderErrors(deck.order, written, seen));
  if (deck.cover !== undefined && !seen.has(deck.cover)) errors.push(error('cover', `names "${deck.cover}", which is not in order`, "the cover slide's id from order"));
  if (deck.sections !== undefined) errors.push(...sectionErrors(deck.sections, seen));
  if (deck.faces !== undefined) errors.push(...faceErrors(deck.faces));
  return errors;
}

/** The order's errors; fills `seen` with its ids. */
function orderErrors(order, written, seen) {
  const errors = [];
  if (order.length > LIMITS.slides) errors.push(error('order', `holds ${order.length} slides`, `at most ${LIMITS.slides}: split the deck`));
  order.forEach((id, at) => {
    if (typeof id !== 'string' || !SLIDE_ID.test(id)) errors.push(error(`order[${at}]`, `${JSON.stringify(id)} is not a slide id`, 'letters, digits, _ and -, at most 64'));
    else if (seen.has(id)) errors.push(error(`order[${at}]`, `names "${id}" twice`, 'each slide once'));
    else if (!written.has(id)) errors.push(error(`order[${at}]`, `names slide "${id}", but project/slides/${id}.html is missing`, `write project/slides/${id}.html, or take "${id}" out of order`));
    seen.add(id);
  });
  return errors;
}

function sectionErrors(sections, seen) {
  if (!isObject(sections)) return [error('sections', 'is not an object', '"sections": {"s1": {"description": "…", "start": "cover"}}')];
  return Object.entries(sections).flatMap(([key, section]) => [
    ...(typeof section?.description === 'string' ? [] : [error(`sections.${key}`, 'has no description', '{"description": "one sentence", "start": "<slide id>"}')]),
    ...(seen.has(section?.start) ? [] : [error(`sections.${key}.start`, `names ${JSON.stringify(section?.start)}, which is not in order`, "its first slide's id from order")]),
  ]);
}

function faceErrors(faces) {
  if (!isObject(faces)) return [error('faces', 'is not an object', '"faces": {"inter": {"family": "Inter", "href": "https://fonts.googleapis.com/css2?family=Inter"}}')];
  const entries = Object.entries(faces);
  const errors = entries.length > LIMITS.faces ? [error('faces', `names ${entries.length} typefaces`, `at most ${LIMITS.faces}`)] : [];
  for (const [key, face] of entries) errors.push(...oneFaceErrors(key, face));
  return errors;
}

function oneFaceErrors(key, face) {
  const errors = [];
  if (typeof face?.family !== 'string' || !/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(face.family)) errors.push(error(`faces.${key}.family`, `${JSON.stringify(face?.family)} is not a family name`, 'a letter, then letters, digits, spaces, _ or -, 40 at most'));
  const link = 'href: a https://fonts.googleapis.com/css2?… link';
  if (face?.src !== undefined) errors.push(error(`faces.${key}.src`, 'is not allowed: a slide loads no font files', link));
  if (typeof face?.href !== 'string' || !face.href.startsWith('https://fonts.googleapis.com/css2?')) errors.push(error(`faces.${key}.href`, 'is not a Google Fonts css2 link', link));
  return errors;
}
