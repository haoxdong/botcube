// The email format as a JSON schema: an Email's one draft file in Gmail's draft fields (`to`, `cc`, `bcc`, `subject`,
// `htmlBody`, `body`), with `attachments` naming Files instead of carrying their bytes. Each subschema's `nearest` is
// the allowed form an error names. Browser-safe: the Email Viewer reads a stored version through it.
import { Validator } from '@cfworker/json-schema';

/** No control character: a header line ends at CR or LF, so one in a header field would start a header of its own. */
const HEADER_TEXT = '^[^\\p{Cc}]*$';
const ADDRESS = '^[^\\s\\p{Cc}@<>,;"]+@[^\\s\\p{Cc}@<>,;"]+$';

const ADDRESSES = {
  type: 'array',
  nearest: 'a list of plain addresses, such as ["dana@example.com"]',
  items: { type: 'string', pattern: ADDRESS, nearest: 'a plain address, such as dana@example.com' },
};

export const EMAIL_SCHEMA = {
  type: 'object',
  nearest: 'a draft object: {"to": [...], "subject": "...", "htmlBody": "..."}',
  required: ['htmlBody'],
  propertyNames: {
    enum: ['to', 'cc', 'bcc', 'subject', 'htmlBody', 'body', 'attachments'],
    nearest: 'one of to, cc, bcc, subject, htmlBody, body, attachments',
    nearestFor: {
      includeSignature: 'leave it out: write any signature into htmlBody',
      replyToMessageId: 'leave it out: a draft here starts a new message',
    },
  },
  properties: {
    to: ADDRESSES,
    cc: ADDRESSES,
    bcc: ADDRESSES,
    subject: { type: 'string', pattern: HEADER_TEXT, nearest: 'one line of text, with no line break or control character' },
    htmlBody: { type: 'string', nearest: 'htmlBody: the body as HTML, such as "<p>Hi Dana,</p>"' },
    body: { type: 'string', nearest: 'a string of plain text, without Markdown' },
    attachments: {
      type: 'array',
      nearest: 'a list of {"file": "/reports/q3.pdf"}',
      items: {
        type: 'object',
        nearest: '{"file": "/reports/q3.pdf"}',
        required: ['file'],
        propertyNames: {
          enum: ['file', 'filename', 'mimeType'],
          nearest: 'one of file, filename, mimeType',
          nearestFor: { content: "file: the attachment's path in Files, not its bytes" },
        },
        properties: {
          // Each folder named, none hidden, none `.` or `..`: a path that stays inside Files.
          file: { type: 'string', pattern: '^(?:/(?!\\.)[^/\\p{Cc}]+)+$', nearest: "file: the attachment's path in Files, such as /reports/q3.pdf" },
          filename: { type: 'string', pattern: '^[^\\p{Cc}/\\\\"]+$', nearest: 'a file name on one line, without / \\ or ", such as "Q3 review.pdf"' },
          mimeType: { type: 'string', pattern: '^[\\w.+-]+/[\\w.+-]+$', nearest: 'a MIME type, such as application/pdf' },
        },
      },
    },
  },
};

const validator = new Validator(EMAIL_SCHEMA, '2020-12', false);

/** The errors that wrap others; only the innermost one names what is wrong. */
const WRAPPERS = new Set(['properties', 'items', 'propertyNames']);

/** The schema's innermost errors in `draft`, each naming what is wrong where. */
export const schemaErrors = (draft) => validator.validate(draft).errors.filter((error) => !WRAPPERS.has(error.keyword));

/** The draft in `text`, which must hold the email format's fields; throws naming the first that doesn't. */
export function readDraft(text) {
  const draft = JSON.parse(text);
  const [first] = schemaErrors(draft);
  if (first !== undefined) throw new Error(`${first.instanceLocation} ${first.error}`);
  return draft;
}
