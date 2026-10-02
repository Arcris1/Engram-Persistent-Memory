import { isPaused, setPaused } from '../../control/pause.js';

/** `engram pause`: write the flag file; every hook and guarded write tool becomes a no-op. */
export function pauseCommand(): number {
  setPaused(true);
  process.stdout.write('paused\n');
  return 0;
}

/** `engram resume`: remove the flag file. */
export function resumeCommand(): number {
  setPaused(false);
  process.stdout.write('active\n');
  return 0;
}

/** `engram status`: print the current state, `paused` or `active`. */
export function statusCommand(): number {
  process.stdout.write(isPaused() ? 'paused\n' : 'active\n');
  return 0;
}
