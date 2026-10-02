import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActivityChart from '../../web/src/components/ActivityChart.vue';

const activity = Array.from({ length: 14 }, (_, i) => ({ day: `2026-09-${String(19 + i).padStart(2, '0')}`, count: 5 }));

afterEach(() => vi.restoreAllMocks());

function rect(left: number, width: number): DOMRect {
  return { left, width, top: 0, right: left + width, bottom: 10, height: 10, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
}

describe('ActivityChart tooltip', () => {
  function hover(barIndex: number, barLeft: number): ReturnType<typeof mount> {
    const w = mount(ActivityChart, { props: { activity } });
    vi.spyOn(w.find('.chart').element, 'getBoundingClientRect').mockReturnValue(rect(0, 280));
    const bar = w.findAll('rect.bar')[barIndex]!;
    vi.spyOn(bar.element, 'getBoundingClientRect').mockReturnValue(rect(barLeft, 12));
    void bar.trigger('pointerover');
    return w;
  }

  it('aligns the tip to the left edge for the first bar', async () => {
    const w = hover(0, 0);
    await w.vm.$nextTick();
    const tip = w.find('.tip');
    expect(tip.classes()).toContain('start');
    expect(tip.attributes('style')).toContain('left: 0px');
  });

  it('aligns the tip to the right edge for the last bar', async () => {
    const w = hover(13, 268);
    await w.vm.$nextTick();
    const tip = w.find('.tip');
    expect(tip.classes()).toContain('end');
    expect(tip.attributes('style')).toContain('left: 280px');
  });

  it('centres the tip over a bar in the middle', async () => {
    const w = hover(6, 134);
    await w.vm.$nextTick();
    expect(w.find('.tip').classes()).toContain('mid');
    expect(w.find('.tip').attributes('style')).toContain('left: 140px');
  });
});
