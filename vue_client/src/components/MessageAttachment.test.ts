// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

// Two levels, matching the split in the components:
//   - MessageAttachment renders ONE resolved preview.
//   - MessageAttachments decides the ARRANGEMENT (strip vs stacked) and does the settings
//     gating, since it needs the resolved set anyway to make that decision.
//
// The first suite exists because QA saw no YouTube card while the server was verified to be
// answering correctly — nothing was testing the span between those two facts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageAttachment from './MessageAttachment.vue';
import MessageAttachments from './MessageAttachments.vue';
import type { LinkPreview } from '../composables/useLinkPreview.js';
import { useSettingsStore } from '../stores/settings.js';
import { useConfigStore } from '../stores/config.js';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import { MAX_CARDS_PER_MESSAGE } from '../utils/previewUrls.js';

// Resolution is driven by message ingest, so components only read — stub the read. A real
// `ref` is required: the templates rely on Vue's auto-unwrapping, which is keyed on `isRef`.
const resolved = new Map<string, LinkPreview>();
vi.mock('../composables/useLinkPreview.js', () => ({
  useLinkPreview: (url: string) => ref(resolved.get(url) ?? null),
}));

function preview(over: Partial<LinkPreview> & { url: string }): LinkPreview {
  return {
    status: 'ok',
    kind: 'page',
    expiresAt: '2099-01-01T00:00:00Z',
    ...over,
  } as LinkPreview;
}

const YOUTUBE = preview({
  url: 'https://www.youtube.com/watch?v=6yRUqNmcI_M',
  kind: 'video-embed',
  title: 'PAPA NUGS & DJ ADHD - THE VOICES',
  siteName: 'YouTube',
  author: 'Maslow Unknown',
  thumb: '/api/link-preview/media/tok',
  embedUrl: 'https://www.youtube-nocookie.com/embed/6yRUqNmcI_M?autoplay=1&rel=0',
});

const IMAGE = preview({
  url: 'https://e.test/a.png',
  kind: 'image',
  src: '/api/link-preview/media/tok2',
  thumbWidth: 800,
  thumbHeight: 600,
  mime: 'image/png',
});

function seedSettings({ inlineMedia = true, linkPreviews = true, feature = true } = {}) {
  setActivePinia(createPinia());
  // The instance feature flag gates both user settings — a stored `true` must not render on an
  // instance that has the feature off, where the routes aren't even mounted. Defaults on here so
  // the suite is about the user settings; `feature: false` covers the gate itself.
  useConfigStore().features = { linkPreviews: feature };
  const settings = useSettingsStore();
  // Real store values rather than a mocked getter: `effective` is a Pinia getter returning a
  // closure, so it can't be spied — and seeding state exercises the same lookup the app does.
  settings.values = {
    'chat.inline_media.enabled': inlineMedia,
    'chat.link_previews.enabled': linkPreviews,
    'chat.image_modal.enabled': true,
  };
  settings.loaded = true;
}

describe('MessageAttachment — video embed', () => {
  beforeEach(() => seedSettings());

  it('renders a card for a resolved YouTube descriptor', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.text()).toContain('PAPA NUGS');
    expect(wrapper.text()).toContain('YouTube');
  });

  it('shows the play facade, and NOT an iframe, before any click', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    expect(wrapper.find('.card-play').exists()).toBe(true);
    // The privacy property: nothing reaches the video host on render.
    expect(wrapper.find('iframe').exists()).toBe(false);
  });

  it('creates the iframe only once the play button is clicked', async () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    await wrapper.find('.card-play').trigger('click');
    expect(wrapper.find('iframe').attributes('src')).toContain('youtube-nocookie.com');
  });

  it('points the thumbnail at our proxy, never at the origin', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    expect(wrapper.find('.card-thumb-wide').attributes('src')).toBe('/api/link-preview/media/tok');
  });

  it('falls back to a plain card when the kind says video but no embedUrl came with it', () => {
    // ⚠ `kind: 'video-embed'` and `embedUrl` are NOT a guaranteed pair on the wire. The origin
    // allowlist can recognise a page as a video and still withhold the embed URL, and while the
    // server currently downgrades that case to `page`, a client that assumes the pairing renders
    // a play button wired to `src="undefined"` — a facade that swallows the click and can never
    // produce a player. Degrade to the ordinary card, which still links out.
    const wrapper = mount(MessageAttachment, {
      props: { preview: preview({ ...YOUTUBE, embedUrl: undefined }) },
    });
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.find('.card-play').exists()).toBe(false);
    expect(wrapper.find('iframe').exists()).toBe(false);
    // The thumbnail survives, in its small right-aligned form.
    expect(wrapper.find('.card-thumb').attributes('src')).toBe('/api/link-preview/media/tok');
    expect(wrapper.find('.card-title').attributes('href')).toBe(YOUTUBE.url);
  });
});

describe('MessageAttachment — inline image', () => {
  beforeEach(() => seedSettings());

  it('renders through the proxy with its real dimensions', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    const img = wrapper.find('img.inline-image');
    expect(img.attributes('src')).toBe('/api/link-preview/media/tok2');
    // Load-bearing: these reserve the box before the bytes arrive.
    expect(img.attributes('width')).toBe('800');
    expect(img.attributes('height')).toBe('600');
  });

  it('takes its height from the row when it is in a strip', () => {
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE, inStrip: true } });
    expect(wrapper.find('img').classes()).toContain('strip-item');
  });
});

describe('MessageAttachment — the click must not be eaten', () => {
  it('lets the click reach the row when the media viewer is switched off', async () => {
    // ⚠⚠ `@click.stop` runs its modifier BEFORE the handler, so propagation died and the
    // handler's own `image_modal` guard then discarded the event. On touch the row's click is
    // the only opener of the message-actions sheet — hover actions are desktop-only and there
    // is no long-press path — so an image became a dead zone over the biggest target in the row:
    // no viewer, no sheet, nothing at all.
    seedSettings();
    useSettingsStore().values['chat.image_modal.enabled'] = false;
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    const img = wrapper.find('.inline-image');

    let reachedRow = false;
    img.element.addEventListener('click', (e) => {
      // Whatever the row would do, it must at least still SEE the event.
      if (!e.cancelBubble) reachedRow = true;
    });
    await img.trigger('click');
    expect(reachedRow).toBe(true);
    expect(wrapper.emitted('activate')).toBeUndefined();
    // Nor does it advertise a click it won't honour.
    expect(img.attributes('role')).toBeUndefined();
    expect(img.attributes('tabindex')).toBeUndefined();
  });

  it('is reachable from the keyboard when the viewer IS on, and is NAMED', () => {
    // ⚠ The name is the half that's easy to miss. `alt=""` is correct for a decorative image and
    // stops being sufficient the instant `role="button"` is applied — the img role that gave the
    // empty alt its meaning is gone, leaving a focusable control with no accessible name. The
    // filename is carried so a strip of several doesn't present identically-named buttons.
    seedSettings();
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    const img = wrapper.find('.inline-image');
    expect(img.attributes('role')).toBe('button');
    expect(img.attributes('tabindex')).toBe('0');
    expect(img.attributes('aria-label')).toBe('Open image: a.png');
  });

  it('carries no name, and no role, when it is not a control', () => {
    seedSettings();
    useSettingsStore().values['chat.image_modal.enabled'] = false;
    const img = mount(MessageAttachment, { props: { preview: IMAGE } }).find('.inline-image');
    expect(img.attributes('role')).toBeUndefined();
    expect(img.attributes('aria-label')).toBeUndefined();
    // Still decorative, which is what an empty alt is for.
    expect(img.attributes('alt')).toBe('');
  });

  it('activates on Enter and Space, not only on a mouse click', async () => {
    seedSettings();
    const wrapper = mount(MessageAttachment, { props: { preview: IMAGE } });
    await wrapper.find('.inline-image').trigger('keydown.enter');
    await wrapper.find('.inline-image').trigger('keydown.space');
    expect(wrapper.emitted('activate')).toHaveLength(2);
  });
});

describe('MessageAttachment — growth the list can react to', () => {
  it('tells the list when a video finally reports its size', async () => {
    // ⚠ The server measures dimensions for IMAGES only, so a video has no width/height to
    // reserve a box with: it lays out at the UA default 300x150 and jumps to full size when
    // metadata arrives. `previewRevision` has already fired by then and the scroller's
    // ResizeObserver watches its own box rather than its content, so nothing else notices.
    seedSettings();
    const video = preview({ url: 'https://e.test/c.mp4', kind: 'video', src: '/api/lp/media/v' });
    const wrapper = mount(MessageAttachment, { props: { preview: video } });
    await wrapper.find('video').trigger('loadedmetadata');
    expect(wrapper.emitted('measured')).toHaveLength(1);
  });
});

describe('MessageAttachments — arrangement', () => {
  beforeEach(() => resolved.clear());

  function seed(...previews: LinkPreview[]) {
    for (const p of previews) resolved.set(p.url, p);
  }

  const img = (n: number, w: number, h: number) =>
    preview({
      url: `https://e.test/${n}.png`,
      kind: 'image',
      src: `/api/link-preview/media/t${n}`,
      thumbWidth: w,
      thumbHeight: h,
    });

  function mountFor(text: string, opts = {}) {
    seedSettings(opts);
    return mount(MessageAttachments, { props: { text } });
  }

  it('leaves a single image on its own rather than in a one-item strip', () => {
    seed(img(1, 800, 600));
    const wrapper = mountFor('https://e.test/1.png');
    expect(wrapper.find('.filmstrip').exists()).toBe(false);
    expect(wrapper.find('img.inline-image').exists()).toBe(true);
  });

  it('puts two or more images into one horizontal strip', () => {
    // Three portrait screenshots stacked is most of a screen of somebody else's message.
    seed(img(1, 800, 600), img(2, 800, 600));
    const strip = mountFor('https://e.test/1.png https://e.test/2.png').find('.filmstrip');
    expect(strip.exists()).toBe(true);
    expect(strip.findAll('img').length).toBe(2);
  });

  it('uses the landscape row height when the group is mostly wide', () => {
    seed(img(1, 800, 600), img(2, 1200, 500));
    const wrapper = mountFor('https://e.test/1.png https://e.test/2.png');
    expect(wrapper.find('.filmstrip').attributes('style')).toContain('200px');
  });

  it('uses the taller row height when the group is mostly portrait', () => {
    seed(img(1, 600, 900), img(2, 500, 1000));
    const wrapper = mountFor('https://e.test/1.png https://e.test/2.png');
    expect(wrapper.find('.filmstrip').attributes('style')).toContain('300px');
  });

  it('does not let one tall image make a wide group tall', () => {
    // "Primarily portrait", not "any portrait".
    seed(img(1, 600, 900), img(2, 1200, 500), img(3, 1000, 400));
    const wrapper = mountFor('https://e.test/1.png https://e.test/2.png https://e.test/3.png');
    expect(wrapper.find('.filmstrip').attributes('style')).toContain('200px');
  });

  it('caps CARDS against the server answer, not against the extension guess', () => {
    // ⚠ `previewableUrls` charges anything that LOOKS like media to the generous media budget
    // (20), because a strip costs the same at 2 as at 12. But an image-looking URL that resolves
    // as a page — an extensionless CDN link, a .png that redirects to an HTML login page —
    // becomes a CARD, and a card costs real vertical space. Applying the tight cap only to the
    // guess meant twenty such links rendered twenty stacked cards and took over the screen.
    const urls: string[] = [];
    for (let n = 0; n < 8; n++) {
      const url = `https://e.test/looks-like-media${n}.png`;
      urls.push(url);
      resolved.set(url, preview({ url, kind: 'page', title: `T${n}` }));
    }
    seedSettings();
    const wrapper = mount(MessageAttachments, { props: { text: urls.join(' ') } });
    expect(wrapper.findAll('.card')).toHaveLength(MAX_CARDS_PER_MESSAGE);
  });

  it('keeps cards out of the strip', () => {
    seed(img(1, 800, 600), img(2, 800, 600), YOUTUBE);
    const wrapper = mountFor(`https://e.test/1.png https://e.test/2.png ${YOUTUBE.url}`);
    expect(wrapper.find('.filmstrip').findAll('img').length).toBe(2);
    expect(wrapper.find('.card').exists()).toBe(true);
  });

  it('renders nothing at all when both settings are off', () => {
    seed(img(1, 800, 600), YOUTUBE);
    const wrapper = mountFor(`https://e.test/1.png ${YOUTUBE.url}`, {
      inlineMedia: false,
      linkPreviews: false,
    });
    expect(wrapper.find('.attachments').exists()).toBe(false);
  });

  it('gates media and cards on their own settings, by the server answer', () => {
    seed(img(1, 800, 600), YOUTUBE);
    const text = `https://e.test/1.png ${YOUTUBE.url}`;

    const mediaOnly = mountFor(text, { inlineMedia: true, linkPreviews: false });
    expect(mediaOnly.find('img.inline-image').exists()).toBe(true);
    expect(mediaOnly.find('.card').exists()).toBe(false);

    const pagesOnly = mountFor(text, { inlineMedia: false, linkPreviews: true });
    expect(pagesOnly.find('img.inline-image').exists()).toBe(false);
    expect(pagesOnly.find('.card').exists()).toBe(true);
  });

  it('renders nothing when the INSTANCE has the feature off', () => {
    // Both user settings on, feature flag off: nothing renders. A stored `true` carried over
    // from another instance must not draw a card the server here could never resolve.
    seed(img(1, 800, 600), YOUTUBE);
    const wrapper = mountFor(`https://e.test/1.png ${YOUTUBE.url}`, { feature: false });
    expect(wrapper.find('.attachments').exists()).toBe(false);
  });

  it('renders nothing for an unavailable preview', () => {
    seed(preview({ url: 'https://e.test/gone', status: 'unavailable' }));
    expect(mountFor('https://e.test/gone').find('.attachments').exists()).toBe(false);
  });

  it('renders nothing while a preview is still unresolved', () => {
    // The ingest-driven model's normal early state, and the case a row must render as
    // "nothing" rather than as a placeholder that later collapses.
    expect(mountFor('https://e.test/not-primed').find('.attachments').exists()).toBe(false);
  });
});

describe('MessageAttachments — the lightbox is a gallery over the strip', () => {
  beforeEach(() => {
    resolved.clear();
    useMediaViewer().close();
  });

  const img = (n: number) =>
    preview({
      url: `https://e.test/${n}.png`,
      kind: 'image',
      src: `/api/link-preview/media/t${n}`,
      thumbWidth: 800,
      thumbHeight: 600,
    });

  it('opens every image in the strip, positioned on the one clicked', async () => {
    // This is what makes a generous media cap safe: however many images a message carries,
    // all of them are reachable by arrowing through the viewer.
    for (const n of [1, 2, 3]) resolved.set(img(n).url, img(n));
    seedSettings();
    const wrapper = mount(MessageAttachments, {
      props: { text: 'https://e.test/1.png https://e.test/2.png https://e.test/3.png' },
    });

    await wrapper.findAll('.filmstrip img')[1].trigger('click');

    const viewer = useMediaViewer();
    expect(viewer.isOpen.value).toBe(true);
    expect(viewer.count.value).toBe(3);
    expect(viewer.index.value).toBe(1);
    // ⚠ OUR proxy path, not the origin URL. Handing the viewer `preview.url` broke the promise
    // the setting makes in words ("the site hosting it never sees your device") — the image
    // rendered inline via the proxy and then the click went straight to the remote host — and
    // made an `http://` image fail as mixed content once the lightbox loaded it directly.
    expect(viewer.url.value).toBe('/api/link-preview/media/t2');
    expect(viewer.items.value.map((i) => i.url)).toEqual([
      '/api/link-preview/media/t1',
      '/api/link-preview/media/t2',
      '/api/link-preview/media/t3',
    ]);
    // And the arrows are live in both directions, which is the whole point.
    expect(viewer.hasPrev.value).toBe(true);
    expect(viewer.hasNext.value).toBe(true);
    // ⚠ ...but "copy link" must hand over the ORIGIN. The rendered path is relative and behind
    // requireAuth, so copying it produced something that resolves to nothing for anybody else —
    // not even another user on the same instance — while the link TEXT in the same message
    // copied the real URL. Two controls, two answers, one of them useless.
    expect(viewer.shareUrl.value).toBe('https://e.test/2.png');
    expect(viewer.items.value.map((i) => i.shareUrl)).toEqual([
      'https://e.test/1.png',
      'https://e.test/2.png',
      'https://e.test/3.png',
    ]);
  });

  it('carries the origin for a lone image too', () => {
    const one = img(9);
    resolved.set(one.url, one);
    seedSettings();
    const wrapper = mount(MessageAttachments, { props: { text: one.url } });
    void wrapper.find('.inline-image').trigger('click');
    const viewer = useMediaViewer();
    expect(viewer.url.value).toBe('/api/link-preview/media/t9');
    expect(viewer.shareUrl.value).toBe('https://e.test/9.png');
  });

  it('opens a lone image as a gallery of one, also through the proxy', () => {
    resolved.set(img(1).url, img(1));
    seedSettings();
    const wrapper = mount(MessageAttachments, { props: { text: 'https://e.test/1.png' } });
    wrapper.find('img.inline-image').trigger('click');
    expect(useMediaViewer().count.value).toBe(1);
    expect(useMediaViewer().url.value).toBe('/api/link-preview/media/t1');
  });

  it('does not open anything when the media viewer is switched off', async () => {
    for (const n of [1, 2]) resolved.set(img(n).url, img(n));
    // Hand-built rather than via seedSettings because this one needs image_modal OFF.
    setActivePinia(createPinia());
    useConfigStore().features = { linkPreviews: true };
    const settings = useSettingsStore();
    settings.values = {
      'chat.inline_media.enabled': true,
      'chat.link_previews.enabled': true,
      'chat.image_modal.enabled': false,
    };
    settings.loaded = true;
    const wrapper = mount(MessageAttachments, {
      props: { text: 'https://e.test/1.png https://e.test/2.png' },
    });
    await wrapper.findAll('.filmstrip img')[0].trigger('click');
    expect(useMediaViewer().isOpen.value).toBe(false);
  });
});

describe('MessageAttachments — the strip advertises that it scrolls', () => {
  beforeEach(() => resolved.clear());

  // ⚠⚠ happy-dom reports every box as zero, so `scrollWidth - clientWidth` is 0 and BOTH edges
  // read as reached no matter what the code does. The previous version of this suite asserted
  // exactly that and was therefore vacuous — it passed with `updateEdges` inverted. Geometry has
  // to be stubbed for the assertion to be about this component at all.
  function stripWith(geometry: { scrollLeft: number; scrollWidth: number; clientWidth: number }) {
    for (const n of [1, 2, 3]) {
      const p = preview({
        url: `https://e.test/${n}.png`,
        kind: 'image',
        src: `/api/link-preview/media/t${n}`,
        thumbWidth: 800,
        thumbHeight: 600,
      });
      resolved.set(p.url, p);
    }
    seedSettings();
    const strip = mount(MessageAttachments, {
      props: { text: 'https://e.test/1.png https://e.test/2.png https://e.test/3.png' },
    }).find('.filmstrip');
    for (const [key, value] of Object.entries(geometry)) {
      Object.defineProperty(strip.element, key, { value, configurable: true });
    }
    return strip;
  }

  it('shows no fade when there is nothing to scroll to', () => {
    // A permanent fade would be a lie in both directions: it implies more content when the
    // strip is fully scrolled, and dims the first image when there's nothing to the left.
    const strip = stripWith({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 });
    void strip.trigger('scroll');
    expect(strip.classes()).not.toContain('fade-start');
    expect(strip.classes()).not.toContain('fade-end');
  });

  it('fades only the end while sitting at the left edge', async () => {
    const strip = stripWith({ scrollLeft: 0, scrollWidth: 1000, clientWidth: 300 });
    await strip.trigger('scroll');
    expect(strip.classes()).toContain('fade-end');
    expect(strip.classes()).not.toContain('fade-start');
  });

  it('fades both sides in the middle', async () => {
    const strip = stripWith({ scrollLeft: 350, scrollWidth: 1000, clientWidth: 300 });
    await strip.trigger('scroll');
    expect(strip.classes()).toContain('fade-start');
    expect(strip.classes()).toContain('fade-end');
  });

  it('fades only the start once scrolled to the far end', async () => {
    const strip = stripWith({ scrollLeft: 700, scrollWidth: 1000, clientWidth: 300 });
    await strip.trigger('scroll');
    expect(strip.classes()).toContain('fade-start');
    expect(strip.classes()).not.toContain('fade-end');
  });
});
