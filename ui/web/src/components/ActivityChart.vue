<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatNumber, formatShortDay } from '../format';

const props = defineProps<{ activity: { day: string; count: number }[] }>();

const W = 280;
const H = 84;
const BW = 12;
const BASE = H - 16;

const max = computed(() => Math.max(0, ...props.activity.map((a) => a.count)));
const bars = computed(() => {
  const n = props.activity.length;
  const gap = n > 1 ? (W - BW * n) / (n - 1) : 0;
  return props.activity.map((a, i) => {
    const h = a.count > 0 ? Math.max(2, (a.count / max.value) * (H - 18)) : 0;
    return { x: i * (BW + gap), h, y: BASE - h, tip: `${formatShortDay(a.day)}: ${formatNumber(a.count)} captured`, count: a.count };
  });
});
const first = computed(() => (props.activity[0] ? formatShortDay(props.activity[0].day) : ''));
const last = computed(() => (props.activity.length ? formatShortDay(props.activity[props.activity.length - 1]!.day) : ''));
const label = computed(() => {
  if (max.value === 0) return `No messages captured, ${first.value} to ${last.value}.`;
  const busiest = props.activity.reduce((a, b) => (b.count > a.count ? b : a));
  return `Messages captured per day, ${first.value} to ${last.value}. Busiest day ${formatShortDay(busiest.day)} with ${formatNumber(busiest.count)}.`;
});

const chart = ref<HTMLElement | null>(null);
const tip = ref<{ text: string; left: number; top: number; align: 'start' | 'mid' | 'end' } | null>(null);
const on = ref<number | null>(null);

function show(e: Event, i: number): void {
  const bar = e.target as Element;
  const box = chart.value;
  if (!box) return;
  const c = box.getBoundingClientRect();
  const b = bar.getBoundingClientRect();
  on.value = i;
  const centre = b.left + b.width / 2 - c.left;
  // Bars near either edge align the tip to that edge so it never pokes out of the chart box (and widens the page).
  const edge = c.width * 0.25;
  if (centre < edge) tip.value = { text: bars.value[i]!.tip, left: 0, top: b.top - c.top - 6, align: 'start' };
  else if (centre > c.width - edge) tip.value = { text: bars.value[i]!.tip, left: c.width, top: b.top - c.top - 6, align: 'end' };
  else tip.value = { text: bars.value[i]!.tip, left: centre, top: b.top - c.top - 6, align: 'mid' };
}
function hide(): void {
  tip.value = null;
  on.value = null;
}
</script>

<template>
  <div ref="chart" class="chart">
    <svg :viewBox="`0 0 ${W} ${H}`" role="group" :aria-label="label">
      <line x1="0" :x2="W" :y1="BASE" :y2="BASE"></line>
      <template v-for="(b, i) in bars" :key="i">
        <rect
          v-if="b.count > 0"
          class="bar"
          :class="{ on: on === i }"
          :x="b.x.toFixed(1)"
          :y="b.y.toFixed(1)"
          :width="BW"
          :height="b.h.toFixed(1)"
          rx="3"
          role="img"
          tabindex="0"
          :aria-label="b.tip"
          @pointerover="show($event, i)"
          @pointerleave="hide"
          @focus="show($event, i)"
          @blur="hide"
        ></rect>
      </template>
      <text x="0" :y="H - 3">{{ first }}</text>
      <text :x="W" :y="H - 3" text-anchor="end">{{ last }}</text>
    </svg>
    <div v-if="tip" class="tip" :class="tip.align" :style="{ left: tip.left + 'px', top: tip.top + 'px' }">{{ tip.text }}</div>
  </div>
</template>
