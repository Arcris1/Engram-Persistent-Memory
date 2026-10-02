import crypto from 'node:crypto';
import type { ForgetPlan } from './core.js';

/** Fingerprint of a forget plan: the target and the exact sets of events and claims it would delete. */
export function digest(plan: ForgetPlan): string {
  const text = JSON.stringify({ target: plan.target, events: [...plan.events].sort(), claims: [...plan.claims].sort() });
  return crypto.createHash('sha256').update(text).digest('hex');
}
