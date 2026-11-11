import type { EmailDraft } from "botcube-artifact-check/email-schema";
import { createMimeMessage } from "mimetext/browser";

/** An attachment's bytes, read from Files, with the name and type the draft gives it. */
export type Attached = { filename: string; mimeType: string; bytes: Uint8Array };

/** MIME's base64 body lines: at most 76 characters (RFC 2045). */
const lines = (base64: string) => base64.replace(/.{76}/g, "$&\r\n");

function base64Of(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return lines(btoa(binary));
}

/**
 * The draft as an unsent `.eml`: `X-Unsent: 1` makes a mail client open it as a draft to send, with the HTML body,
 * `plain` as its text alternative and the attached files.
 */
export function emlOf(draft: EmailDraft, plain: string, attachments: readonly Attached[]): Blob {
  const message = createMimeMessage();
  // mimetext requires a sender and derives Message-ID from it; an unsent draft has neither, and the mail client sets
  // From from the account that sends it.
  for (const field of message.headers.fields) if (field.name === "From" || field.name === "Message-ID") field.disabled = true;
  const { to, cc, bcc, subject } = draft;
  if (to?.length) message.setTo(to);
  if (cc?.length) message.setCc(cc);
  if (bcc?.length) message.setBcc(bcc);
  message.setSubject(subject ?? "");
  message.setHeader("X-Unsent", "1");
  const utf8 = new TextEncoder();
  message.addMessage({ contentType: "text/plain", encoding: "base64", data: base64Of(utf8.encode(plain)) });
  message.addMessage({ contentType: "text/html", encoding: "base64", data: base64Of(utf8.encode(draft.htmlBody)) });
  for (const { filename, mimeType, bytes } of attachments) {
    message.addAttachment({ filename, contentType: mimeType, data: base64Of(bytes) });
  }
  return new Blob([message.asRaw()], { type: "message/rfc822" });
}
