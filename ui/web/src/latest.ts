/**
 * Guards against out-of-order responses. Call the returned function when a request starts; it gives back a
 * `isCurrent()` check. After the await, `if (!isCurrent()) return;` drops a result (or failure) that a newer
 * request has already overtaken.
 */
export function useLatest(): () => () => boolean {
  let n = 0;
  return () => {
    const mine = ++n;
    return () => mine === n;
  };
}
