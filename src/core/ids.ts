import { monotonicFactory } from 'ulid';

const nextUlid = monotonicFactory();

export function newId(): string {
  return nextUlid();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Normalise any parseable date to ISO-8601 UTC; missing or unparseable → now. */
export function toIso(value?: string): string {
  if (!value) return nowIso();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString();
}
