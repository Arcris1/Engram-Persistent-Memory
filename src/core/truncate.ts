const MAX_BYTES = 32 * 1024;
const HEAD_BYTES = 24 * 1024;
const TAIL_BYTES = 8 * 1024;
const MARKER = '\n…[truncated]…\n';

const isContinuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;

export function capSize(text: string): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_BYTES) return { text, truncated: false };
  let headEnd = HEAD_BYTES;
  while (headEnd > 0 && isContinuation(buf[headEnd])) headEnd--;
  let tailStart = buf.length - TAIL_BYTES;
  while (tailStart < buf.length && isContinuation(buf[tailStart])) tailStart++;
  const head = buf.subarray(0, headEnd).toString('utf8');
  const tail = buf.subarray(tailStart).toString('utf8');
  return { text: `${head}${MARKER}${tail}`, truncated: true };
}
