import type { Scope } from './types.js';

// HANDOFF §5.2: imperative-toward-AI patterns. Flagged content is stored but never auto-injected.
// DECISIONS "Open concern": these also match genuine user preferences ("from now on use pnpm").
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\bignore (?:all |any )?(?:the |your )?(?:previous|prior|above|earlier) (?:instructions?|prompts?|messages?|rules)\b/i,
  /\bignore your (?:instructions|rules|guidelines|system prompt)\b/i,
  /\bdisregard (?:all |any )?(?:the |your )?(?:previous|prior|above|earlier)?\s*(?:instructions?|rules|guidelines)\b/i,
  /\byou must (?:always|never)\b/i,
  /\bfrom now on\b/i,
  /\bsystem prompt\b/i,
  /\b(?:new|updated) instructions?\s*:/i,
  /\byou are now\b/i,
  /\bdo not (?:tell|inform) the user\b/i,
];

// HANDOFF §5.3: first match wins; default 'fact'. Consolidation may refine later.
const SCOPE_PATTERNS: Array<[Scope, RegExp]> = [
  ['draft', /^\s*draft\s*:/im],
  ['roleplay', /\b(?:let'?s )?pretend\b|\brole-?play\b|\bin character\b/i],
  ['roleplay', /\bwrite (?:me )?an? (?:short )?(?:story|poem|scene|fiction)\b/i],
  ['hypothetical', /\bhypothetically\b|\bimagine that\b|\bsuppose that\b/i],
];

export function isInstructionLike(text: string): boolean {
  return INSTRUCTION_PATTERNS.some((re) => re.test(text));
}

export function detectScope(text: string): Scope {
  for (const [scope, re] of SCOPE_PATTERNS) if (re.test(text)) return scope;
  return 'fact';
}
