import { ApiFailure } from './api';

export type Problem = 'disconnected' | 'busy' | 'error';

/** Which of the page-level problem states an API failure maps to. */
export function classify(e: unknown): Problem {
  if (e instanceof ApiFailure) {
    if (e.code === 'unauthorized') return 'disconnected';
    if (e.code === 'busy') return 'busy';
  }
  return 'error';
}

export function failureMessage(e: unknown): string {
  if (e instanceof ApiFailure) {
    if (e.code === 'busy') return 'engram is busy writing. Try again.';
    if (e.code === 'network') return 'Could not reach engram. Is `engram ui` still running?';
  }
  return 'Something went wrong while loading this. Try again.';
}
