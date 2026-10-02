<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ForgetDone, ForgetPreview } from '../../../server/types';
import { api, ApiFailure } from '../api';
import { confirmForget, lockPage } from '../forget';
import { useLatest } from '../latest';
import { failureMessage } from '../load';

const props = defineProps<{ id: string; kind: 'memory' | 'message'; opener: HTMLElement | null }>();
const emit = defineEmits<{ close: []; done: [result: ForgetDone, id: string, erasedIds: string[]]; gone: []; paused: []; disconnected: [] }>();

const preview = ref<ForgetPreview | null>(null);
const loading = ref(true);
const confirming = ref(false);
const message = ref('');
const retry = ref<'preview' | 'confirm' | null>(null);
const dialog = ref<HTMLElement | null>(null);
const keep = ref<HTMLButtonElement | null>(null);
const newest = useLatest();
// What the dialog acts on is fixed when it opens: a later selection or route change must not retarget it.
const targetId = props.id;
const targetKind = props.kind;
const word = computed(() => (targetKind === 'memory' ? 'memory' : 'message'));
const canConfirm = computed(() => preview.value !== null && !loading.value && !confirming.value);

/** Failures every call can have: gone and disconnected go to the parent, anything else (busy included) shows a message with Retry. */
function handleCommon(e: unknown, again: 'preview' | 'confirm'): void {
  if (e instanceof ApiFailure) {
    if (e.code === 'not_found') return void emit('gone');
    if (e.code === 'unauthorized') return void emit('disconnected');
  }
  message.value = failureMessage(e);
  retry.value = again;
}

async function loadPreview(keepMessage = false): Promise<void> {
  const current = newest();
  loading.value = true;
  preview.value = null;
  if (!keepMessage) message.value = '';
  retry.value = null;
  try {
    const p = await api.forgetPreview(targetId);
    if (!current()) return;
    preview.value = p;
  } catch (e) {
    if (current()) handleCommon(e, 'preview');
  } finally {
    if (current()) loading.value = false;
  }
}

async function confirm(): Promise<void> {
  const p = preview.value;
  if (!p || !canConfirm.value) return;
  confirming.value = true;
  dialog.value?.focus(); // the buttons are disabled while it runs: keep focus inside the dialog
  message.value = '';
  retry.value = null;
  try {
    const ids = [...p.erases.memories.map((x) => x.id), ...p.erases.messages.map((x) => x.id)];
    emit('done', await confirmForget(targetId, p.digest, () => mounted), targetId, ids);
  } catch (e) {
    if (e instanceof ApiFailure && e.code === 'changed') {
      message.value = 'This changed since you looked. Review it again.';
      void loadPreview(true);
    } else if (e instanceof ApiFailure && e.code === 'paused') {
      message.value = 'engram is paused. Resume capture to forget.';
      emit('paused');
    } else handleCommon(e, 'confirm');
  } finally {
    confirming.value = false;
  }
}

function again(): void {
  if (retry.value === 'confirm') void confirm();
  else void loadPreview();
}

/** Closing is ignored while a permanent delete is in flight, so its result is always shown. */
function close(): void {
  if (!confirming.value) emit('close');
}

function focusables(): HTMLElement[] {
  return Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? []);
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Tab') {
    const f = focusables();
    if (!f.length) return e.preventDefault();
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const active = document.activeElement;
    if (!dialog.value?.contains(active)) {
      e.preventDefault();
      first.focus();
    } else if (e.shiftKey && active === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

let mounted = true;
let unlock: (() => void) | null = null;
onMounted(() => {
  document.addEventListener('keydown', onKey);
  if (dialog.value) unlock = lockPage(dialog.value.parentElement ?? dialog.value);
  keep.value?.focus();
  void loadPreview();
});
onBeforeUnmount(() => {
  mounted = false;
  unlock?.();
  document.removeEventListener('keydown', onKey);
  if (props.opener?.isConnected) props.opener.focus();
});
const cut = (s: string): string => (s.length > 80 ? `${s.slice(0, 80)}…` : s);
</script>

<template>
  <div class="scrim" @click.self="close">
    <div ref="dialog" class="dialog" role="dialog" aria-modal="true" aria-labelledby="forget-h" :aria-busy="confirming" tabindex="-1">
      <h2 id="forget-h">Forget this {{ word }}?</h2>
      <div class="dbody">
      <p>This erases it from the database for good. It cannot be undone.</p>
      <p v-if="loading && !message" role="status">Checking what would be erased…</p>
      <ul v-if="preview">
        <li v-for="m in preview.erases.memories" :key="m.id">Memory: “{{ cut(m.statement) }}”</li>
        <li v-for="m in preview.erases.messages" :key="m.id">Captured message: “{{ cut(m.text) }}”</li>
        <li>Its search entries</li>
      </ul>
      <div v-for="n in preview?.notes ?? []" :key="n" class="keep">{{ n }}</div>
      <p v-if="message" class="warning" role="alert">{{ message }}</p>
      </div>
      <div class="actions">
        <button v-if="retry" type="button" class="btn" @click="again">Retry</button>
        <button ref="keep" type="button" class="btn" :disabled="confirming" @click="close">Keep it</button>
        <button type="button" class="btn danger solid" :disabled="!canConfirm" @click="confirm">{{ confirming ? 'Forgetting…' : 'Forget permanently' }}</button>
      </div>
    </div>
  </div>
</template>
