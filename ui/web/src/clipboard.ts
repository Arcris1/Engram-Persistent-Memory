import { useToasts } from './format';

/** Copies text and says so in a toast; where the clipboard is unavailable the text itself is shown so it can be selected. */
export async function copyText(text: string): Promise<void> {
  const { show } = useToasts();
  try {
    await navigator.clipboard.writeText(text);
    show('Copied');
  } catch {
    show(text);
  }
}
