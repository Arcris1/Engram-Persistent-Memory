import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../src/core/redact.js';

// Fake credentials only. None of these are real.
const JWT =
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
const PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAfakefakefake\n-----END RSA PRIVATE KEY-----';

describe('redactSecrets', () => {
  it.each([
    ['my key is sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx', 'my key is [REDACTED:api_key]', 'api_key'],
    ['export OPENAI=sk-proj-AbCdEfGhIjKlMnOpQrSt', 'export OPENAI=[REDACTED:api_key]', 'api_key'],
    // Built by concatenation so the fake key never appears whole in the source (secret scanners flag it).
    ['stripe ' + 'sk_' + 'live_4eC39HqLyjWDarjtT1zdp7dc ok', 'stripe [REDACTED:api_key] ok', 'api_key'],
    ['aws AKIAIOSFODNN7EXAMPLE', 'aws [REDACTED:api_key]', 'api_key'],
    ['gh ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', 'gh [REDACTED:token]', 'token'],
    ['slack xoxb-123456789012-abcdefghij', 'slack [REDACTED:token]', 'token'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456', 'Authorization: Bearer [REDACTED:token]', 'token'],
    [`token ${JWT}`, 'token [REDACTED:jwt]', 'jwt'],
    [`key:\n${PEM}\nend`, 'key:\n[REDACTED:private_key]\nend', 'private_key'],
    ['password=hunter2secret', 'password=[REDACTED:password]', 'password'],
    ['DB_PASSWORD: "s3cr3t!x"', 'DB_PASSWORD: "[REDACTED:password]"', 'password'],
    ['card 4111 1111 1111 1111 exp', 'card [REDACTED:credit_card] exp', 'credit_card'],
    ['{"password": "hunter22secret"}', '{"password": "[REDACTED:password]"}', 'password'],
    [`{'password': 'hunter22secret'}`, `{'password': '[REDACTED:password]'}`, 'password'],
    ['"api_key": "abcd1234efgh"', '"api_key": "[REDACTED:password]"', 'password'],
    ['SECRET_KEY=abcd1234efgh', 'SECRET_KEY=[REDACTED:password]', 'password'],
    ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG', 'AWS_SECRET_ACCESS_KEY=[REDACTED:password]', 'password'],
    ['aws_secret_access_key = wJalrXUtnFEMI', 'aws_secret_access_key = [REDACTED:password]', 'password'],
    ['private_key: "abcd1234efgh"', 'private_key: "[REDACTED:password]"', 'password'],
    [
      'DATABASE_URL=postgres://admin:S3cr3tPass@db.internal:5432/app',
      'DATABASE_URL=postgres://admin:[REDACTED:password]@db.internal:5432/app',
      'password',
    ],
    ['key AIzaSyA1234567890abcdefghijklmnopqrstuv', 'key [REDACTED:api_key]', 'api_key'],
    ['glpat-AbCdEfGhIjKlMnOpQrSt12', '[REDACTED:token]', 'token'],
    ['npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789', '[REDACTED:token]', 'token'],
    ['Authorization: Basic dXNlcjpwYXNzd29yZA==', 'Authorization: Basic [REDACTED:token]', 'token'],
  ])('redacts %j', (input, expected, type) => {
    const r = redactSecrets(input);
    expect(r.text).toBe(expected);
    expect(r.types).toContain(type);
  });

  it.each([
    'the sky is blue',
    'task-1234567890abcdefghij is a branch name',
    'timestamp 1727251200000',
    'invalid card 4111111111111112',
    'the secretary: Bob',
    'secret = 42',
    'see https://example.com/a:b/c',
  ])('leaves %j alone', (input) => {
    expect(redactSecrets(input)).toEqual({ text: input, types: [] });
  });

  it('does not double-redact key=value around an already-redacted key', () => {
    expect(redactSecrets('api_key=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWx').text).toBe('api_key=[REDACTED:api_key]');
  });
});

describe('redactSecrets performance', () => {
  it('redacts a-/- repeated 160k times in under 1000ms', () => {
    const input = 'a-'.repeat(160_000);
    const start = performance.now();
    redactSecrets(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it('redacts -xpassword repeated 40k times in under 1000ms', () => {
    const input = '-xpassword'.repeat(40_000);
    const start = performance.now();
    redactSecrets(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
