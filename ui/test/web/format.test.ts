import { describe, expect, it } from 'vitest';
import { aboutLabel, flagLabel, formatBytes, formatDay, formatDayTime, formatShortDay, plural, roleLabel, usedLabel } from '../../web/src/format';

describe('formatBytes', () => {
  it('reads like a person would', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(8 * 1024 * 1024)).toBe('8.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(-1)).toBe('0 B');
  });
});

describe('format', () => {
  it('formats days like the mockup', () => {
    expect(formatDay('2026-10-02T12:00:00Z')).toBe('2 Oct 2026');
    expect(formatDayTime('2026-10-02T12:00:00Z')).toMatch(/^2 Oct 2026, \d\d:\d\d$/);
    expect(formatShortDay('2026-09-28')).toBe('28 Sep');
    expect(formatDay('not a date')).toBe('not a date');
  });
  it('plural picks the word', () => {
    expect(plural(1, 'message', 'messages')).toBe('message');
    expect(plural(0, 'message', 'messages')).toBe('messages');
    expect(plural(2, 'message', 'messages')).toBe('messages');
  });
  it('flagLabel speaks plain words', () => {
    expect(flagLabel('instruction_like')).toBe('Looks like an instruction');
    expect(flagLabel('secret_redacted')).toBe('Secret removed before saving');
    expect(flagLabel('truncated')).toBe('Shortened');
    expect(flagLabel('imported')).toBeNull();
  });
  it('roleLabel', () => {
    expect(roleLabel('user')).toBe('You');
    expect(roleLabel('assistant')).toBe('Claude');
    expect(roleLabel('tool')).toBe('A tool result');
    expect(roleLabel('system')).toBe('System');
  });
});

describe('aboutLabel and usedLabel', () => {
  it('humanises subject and predicate for display', () => {
    expect(aboutLabel('user', 'owns_peripheral')).toBe('You, owns peripheral');
    expect(aboutLabel('project:nova', 'uses_linter')).toBe('Project nova, uses linter');
    expect(aboutLabel('claude', 'prefers_short_replies')).toBe('claude, prefers short replies');
  });
  it('words the usage count', () => {
    expect(usedLabel(0)).toBe('Not yet');
    expect(usedLabel(1)).toBe('1 time');
    expect(usedLabel(4)).toBe('4 times');
  });
});
