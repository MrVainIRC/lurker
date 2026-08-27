// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import ContextMenu from './ContextMenu.vue';
import { useContextMenu, type ContextMenuItem } from '../composables/useContextMenu.js';

const originalInnerWidth = window.innerWidth;
const originalInnerHeight = window.innerHeight;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function renderedMenu(): HTMLElement {
  const menu = document.body.querySelector<HTMLElement>('.context-menu');
  if (!menu) throw new Error('context menu was not teleported into document.body');
  return menu;
}

async function flushMenu(): Promise<void> {
  await nextTick();
  await nextTick();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  useContextMenu().close();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: originalInnerWidth,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: originalInnerHeight,
  });
});

describe('ContextMenu placement', () => {
  it('opens the main mobile message menu at the viewport edge', async () => {
    setViewport(320, 640);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('context-menu')) return rect(0, 0, 160, 120);
        return rect(0, 0, 0, 0);
      },
    );

    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = useContextMenu();
    // The tap is in the middle of the message. The placement hint, not the
    // message end/cursor coordinate, must determine the horizontal position.
    menu.open([{ label: 'Reply', onClick: () => {} }], 100, 100, null, null, 'mobile-edge');

    await flushMenu();

    expect(renderedMenu().getAttribute('style')).toContain('left: 156px');
    wrapper.unmount();
  });

  it('opens a direct reaction grid to the left of its hover action button', async () => {
    setViewport(320, 640);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('context-menu')) return rect(0, 0, 256, 120);
        return rect(0, 0, 0, 0);
      },
    );

    const trigger = document.createElement('button');
    trigger.getBoundingClientRect = () => rect(280, 100, 26, 26);
    document.body.append(trigger);
    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = useContextMenu();
    menu.open([{ label: '😀', onClick: () => {} }], 300, 100, trigger, 'grid');

    await flushMenu();

    const menuEl = renderedMenu();
    expect(menuEl.getAttribute('style')).toContain('left: 20px');
    expect(menuEl.getAttribute('style')).toContain('top: 100px');
    wrapper.unmount();
    trigger.remove();
  });

  it('opens a nested reaction grid away from a right-edge action menu', async () => {
    setViewport(320, 640);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      function (this: HTMLElement) {
        if (this.classList.contains('context-menu')) return rect(156, 100, 160, 120);
        if (this.classList.contains('branch')) return rect(156, 100, 156, 40);
        if (this.classList.contains('submenu')) return rect(0, 0, 256, 180);
        return rect(0, 0, 0, 0);
      },
    );

    const wrapper = mount(ContextMenu, { attachTo: document.body });
    const menu = useContextMenu();
    const items: ContextMenuItem[] = [
      { label: 'React', layout: 'grid', children: [{ label: '😀', onClick: () => {} }] },
    ];
    menu.open(items, 280, 100);

    await flushMenu();
    const branchButton = document.body.querySelector<HTMLButtonElement>('.branch > button');
    if (!branchButton) throw new Error('reaction branch was not rendered');
    branchButton.click();
    await flushMenu();

    const submenu = document.body.querySelector<HTMLElement>('.submenu');
    if (!submenu) throw new Error('reaction submenu was not rendered');
    expect(submenu.getAttribute('style')).toContain('left: 4px');
    expect(document.body.querySelector('.arrow')?.classList).toContain('fa-chevron-left');
    wrapper.unmount();
  });
});
