import { detectScope, isInstructionLike } from './detect.js';
import { redactSecrets } from './redact.js';
import { capSize } from './truncate.js';
import type { Scope } from './types.js';

export interface ProcessedContent {
  content: string;
  flags: string[];
  scope: Scope;
}

/** HANDOFF §5 write-time processing. Redaction runs first so a secret is never kept, even partially. */
export function processContent(raw: string, scopeHint?: Scope): ProcessedContent {
  const flags: string[] = [];
  const redacted = redactSecrets(raw);
  if (redacted.types.length > 0) flags.push('secret_redacted');
  const capped = capSize(redacted.text);
  if (capped.truncated) flags.push('truncated');
  if (isInstructionLike(capped.text)) flags.push('instruction_like');
  return { content: capped.text, flags, scope: scopeHint ?? detectScope(capped.text) };
}
