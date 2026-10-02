import { ref, type Ref } from 'vue';

export type ThemeMode = 'system' | 'light' | 'dark';
const KEY = 'engram-ui-theme';

function stored(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage can be blocked */
  }
  return 'system';
}

function apply(m: ThemeMode): void {
  const el = document.documentElement;
  if (m === 'system') el.removeAttribute('data-theme');
  else el.setAttribute('data-theme', m);
}

const mode: Ref<ThemeMode> = ref(stored());
apply(mode.value);

export function useTheme(): { mode: Ref<ThemeMode>; set(m: ThemeMode): void } {
  return {
    mode,
    set(m: ThemeMode): void {
      mode.value = m;
      apply(m);
      try {
        if (m === 'system') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, m);
      } catch {
        /* the choice still applies for this page */
      }
    },
  };
}
