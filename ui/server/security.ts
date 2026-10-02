import crypto from 'node:crypto';

/** Sent on every response: API, static files and errors alike. No CORS headers, ever. */
export const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** 32 random bytes, base64url (43 characters). */
export function newToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function tokenOk(header: string | undefined, token: string): boolean {
  const m = /^Bearer (.+)$/.exec(header ?? '');
  const given = Buffer.from(m?.[1] ?? '');
  const want = Buffer.from(token);
  // timingSafeEqual needs equal lengths; the length of the token is not a secret.
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

/** DNS-rebinding defence: only the two loopback names on our own port. */
export function hostOk(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/** A present Origin must be one of our own two origins (`null`, foreign sites and other ports fail). */
export function originOk(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}
