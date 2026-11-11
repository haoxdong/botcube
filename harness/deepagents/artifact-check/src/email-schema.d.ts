import type { OutputUnit } from '@cfworker/json-schema';

/** An Email's draft as the email format holds it. */
export type EmailDraft = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  htmlBody: string;
  body?: string;
  attachments?: { file: string; filename?: string; mimeType?: string }[];
};
export const EMAIL_SCHEMA: Record<string, unknown>;
export function schemaErrors(draft: unknown): OutputUnit[];
export function readDraft(text: string): EmailDraft;
