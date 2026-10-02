const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** D15: date-only bounds are widened to the whole day; everything else is normalised to ISO UTC. */
export function normalizeBound(value: string, edge: 'start' | 'end'): string {
  if (DATE_ONLY.test(value)) {
    const widened = `${value}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`;
    const d = new Date(widened);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value)
      throw new Error(`Invalid date: ${value}`);
    return widened;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${value}`);
  return d.toISOString();
}
