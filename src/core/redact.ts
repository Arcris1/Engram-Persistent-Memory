export interface RedactResult {
  text: string;
  /** Distinct secret types found, e.g. ['api_key', 'password']. */
  types: string[];
}

interface Rule {
  type: string;
  re: RegExp;
  /** Return the replacement, or null to keep the match unchanged. Default: `[REDACTED:<type>]`. */
  render?: (match: string, groups: string[]) => string | null;
}

function luhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// Order matters: specific formats first, generic key=value after, so a known key is labelled by its type.
const RULES: Rule[] = [
  { type: 'private_key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { type: 'api_key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { type: 'api_key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { type: 'api_key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'token', re: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g },
  { type: 'token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { type: 'token', re: /\bBearer\s+(?!\[REDACTED:)[A-Za-z0-9._~+/-]{20,}=*/g, render: () => 'Bearer [REDACTED:token]' },
  {
    type: 'password',
    // Scheme and userinfo-name are bounded to keep backtracking linear when no '://' or '@' follows.
    re: /\b([a-z][a-z0-9+.-]{0,30}:\/\/[^\s:\/@]{1,256}:)([^\s@\/]{1,256})@/gi,
    render: (_m, [prefix = '']) => `${prefix}[REDACTED:password]@`,
  },
  { type: 'api_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: 'token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { type: 'token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    type: 'token',
    re: /\bBasic\s+(?!\[REDACTED:)[A-Za-z0-9+\/]{8,}={0,2}/g,
    render: () => 'Basic [REDACTED:token]',
  },
  {
    type: 'password',
    re: /\b([A-Za-z0-9_-]{0,64}?(?:password|passwd|pwd|secret|private[_-]?key|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)[A-Za-z0-9_-]{0,32}["']?\s*[:=]\s*)(["']?)(?!\[REDACTED:)([^\s"'`,;]{4,})\2/gi,
    render: (_m, [prefix = '', quote = '']) => `${prefix}${quote}[REDACTED:password]${quote}`,
  },
  {
    type: 'credit_card',
    re: /\b(?:4\d{3}|5[1-5]\d{2}|2[2-7]\d{2}|3[47]\d{2}|6(?:011|5\d{2}))(?:[ -]?\d){9,15}\b/g,
    render: (m) => {
      const digits = m.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? '[REDACTED:credit_card]' : null;
    },
  },
];

export function redactSecrets(input: string): RedactResult {
  let text = input;
  const found = new Set<string>();
  for (const rule of RULES) {
    text = text.replace(rule.re, (match: string, ...rest: unknown[]) => {
      // rest = [...capture groups, offset, fullString]; no named groups are used.
      const groups = rest.slice(0, -2).map((g) => (typeof g === 'string' ? g : ''));
      const replacement = rule.render ? rule.render(match, groups) : `[REDACTED:${rule.type}]`;
      if (replacement === null) return match;
      found.add(rule.type);
      return replacement;
    });
  }
  return { text, types: [...found] };
}
