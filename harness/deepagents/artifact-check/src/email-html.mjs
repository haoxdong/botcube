// What an Email's `htmlBody` may hold: exactly what the Email Viewer's editor (Tiptap's StarterKit, as the panel
// configures it) holds, so the panel shows what the .eml sends and an edit in the panel loses nothing. Each element
// names its attributes, what it is (`block`, `inline`, `list`, `item`), and a sample the web test round-trips through
// the editor. Pure data: the web bundle imports it without the checker.

/** @type {Record<string, {kind: 'block' | 'inline' | 'list' | 'item', attributes: readonly string[], sample: string}>} */
export const EMAIL_ELEMENTS = {
  p: { kind: 'block', attributes: [], sample: '<p>Hi Dana,</p>' },
  h1: { kind: 'block', attributes: [], sample: '<h1>Q3 review</h1>' },
  h2: { kind: 'block', attributes: [], sample: '<h2>Numbers</h2>' },
  h3: { kind: 'block', attributes: [], sample: '<h3>Risks</h3>' },
  blockquote: { kind: 'block', attributes: [], sample: '<blockquote><p>As you wrote last week.</p></blockquote>' },
  hr: { kind: 'block', attributes: [], sample: '<p>Above</p><hr><p>Below</p>' },
  ul: { kind: 'list', attributes: [], sample: '<ul><li><p>Revenue</p></li><li><p>Margin</p></li></ul>' },
  ol: { kind: 'list', attributes: [], sample: '<ol><li><p>Read</p></li><li><p>Reply</p></li></ol>' },
  li: { kind: 'item', attributes: [], sample: '<ul><li><p>One item</p></li></ul>' },
  br: { kind: 'inline', attributes: [], sample: '<p>Best,<br>Sam</p>' },
  strong: { kind: 'inline', attributes: [], sample: '<p><strong>4% over plan</strong></p>' },
  b: { kind: 'inline', attributes: [], sample: '<p><b>4% over plan</b></p>' },
  em: { kind: 'inline', attributes: [], sample: '<p><em>draft</em></p>' },
  i: { kind: 'inline', attributes: [], sample: '<p><i>draft</i></p>' },
  u: { kind: 'inline', attributes: [], sample: '<p><u>by Friday</u></p>' },
  s: { kind: 'inline', attributes: [], sample: '<p><s>Thursday</s></p>' },
  a: { kind: 'inline', attributes: ['href'], sample: '<p><a href="https://example.com/q3">the review</a></p>' },
};

/** A link's target: a web page, an address or a phone number, as a mail client follows one. */
export const EMAIL_HREF = /^(?:https?:\/\/|mailto:|tel:)[^\s"<>]+$/i;

/** The nearest allowed form of an element or attribute the editor can't hold. */
export const NEAREST_EMAIL = {
  table: 'a <ul> of <li><p> rows, or attach the table as a File',
  img: 'attach the image as a File in attachments',
  div: 'a <p>',
  span: 'the text itself, or <strong>, <em> or <u> around it',
  font: 'the text itself, or <strong>, <em> or <u> around it',
  h4: 'an <h3>',
  h5: 'an <h3>',
  h6: 'an <h3>',
  code: 'the text itself',
  pre: 'a <p>',
  del: 'an <s>',
  strike: 'an <s>',
  html: 'the body\'s content alone: <p>Hi Dana,</p>…',
  head: 'the body\'s content alone: <p>Hi Dana,</p>…',
  body: 'the body\'s content alone: <p>Hi Dana,</p>…',
  style: 'leave it out: a mail client styles the body',
  script: 'leave it out: an email runs no script',
  style_attribute: 'leave it out, or <strong>, <em> or <u> around the text',
  attribute: 'leave it out',
};
