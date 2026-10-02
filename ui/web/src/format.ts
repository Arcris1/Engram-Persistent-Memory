import { ref, type Ref } from 'vue';

// Month names are spelled out here so the output does not depend on the browser's ICU data ("Sept" vs "Sep").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number): string => String(n).padStart(2, '0');

/** "2 Oct 2026", in the viewer's time zone. Unparseable input comes back unchanged. */
export function formatDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "2 Oct 2026, 12:55". */
export function formatDayTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** "28 Sep" from a local calendar day like "2026-09-28" (no time zone shift). */
export function formatShortDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  return `${d} ${MONTHS[m - 1]}`;
}

/** The right word for a count: `plural(1, 'message', 'messages')` is "message". The number is not included. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US');
}

/** "8.0 MB", "512 B": sizes as a person reads them (1024-based). */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(1)} ${units[u]}`;
}

const FLAGS: Record<string, string> = {
  instruction_like: 'Looks like an instruction',
  secret_redacted: 'Secret removed before saving',
  truncated: 'Shortened',
};
/** Plain-words label for a stored flag, or null for flags the person does not need to see. */
export function flagLabel(flag: string): string | null {
  return FLAGS[flag] ?? null;
}

export function roleLabel(role: string): 'You' | 'Claude' | 'A tool result' | 'System' {
  if (role === 'user') return 'You';
  if (role === 'assistant') return 'Claude';
  if (role === 'tool') return 'A tool result';
  return 'System';
}

export interface Toast {
  id: number;
  message: string;
}
const items: Ref<Toast[]> = ref([]);
let nextId = 1;

export function useToasts(): { show(msg: string): void; items: Ref<Toast[]> } {
  return {
    items,
    show(msg: string): void {
      const id = nextId++;
      items.value = [...items.value, { id, message: msg }];
      setTimeout(() => {
        items.value = items.value.filter((t) => t.id !== id);
      }, 2200);
    },
  };
}

/** "You, owns peripheral" / "Project nova, uses linter": the subject and predicate of a memory, for display only. */
export function aboutLabel(subject: string, predicate: string): string {
  const who = subject === 'user' ? 'You' : subject.startsWith('project:') ? `Project ${subject.slice('project:'.length)}` : subject;
  return `${who}, ${predicate.replace(/_/g, ' ')}`;
}

/** "Not yet", "1 time", "3 times". */
export function usedLabel(n: number): string {
  return n < 1 ? 'Not yet' : `${n} ${plural(n, 'time', 'times')}`;
}
