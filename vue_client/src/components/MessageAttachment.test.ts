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
import { computed, nextTick, ref, type Ref } from 'vue';
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
//
// ⚠ ONE ref per URL, cached, rather than a fresh one per call. The real composable does the same
// (`entryFor`), and the atomic-reveal suite depends on it: answering a URL AFTER mount has to
// reach the ref the component is already watching. Cleared by the top-level `beforeEach` below.
const resolved = new Map<string, LinkPreview>();
const refs = new Map<string, Ref<LinkPreview | null>>();
function entryRef(url: string): Ref<LinkPreview | null> {
  let entry = refs.get(url);
  if (!entry) {
    entry = ref<LinkPreview | null>(resolved.get(url) ?? null);
    refs.set(url, entry);
  }
  return entry;
}

// URLs the real module would say an answer is still expected for. Kept separate from `resolved`
// because the whole point of the reveal gate is that "no value yet" and "no answer coming" are
// DIFFERENT states — a stub that conflated them could not observe the distinction it exists for.
const inFlight = new Set<string>();
const flightBump = ref(0);

// ⚠ Every export is a lazy arrow, so nothing here is dereferenced at factory time. A `vi.mock`
// factory runs before this file's module-level consts initialise, which is why a value export
// (`previewRevision: ref(0)`) dies at collection and these do not.
vi.mock('../composables/useLinkPreview.js', () => ({
  useLinkPreview: (url: string) => entryRef(url),
  usePreviewsSettled: (urls: Ref<readonly string[]>) =>
    computed(() => {
      void flightBump.value;
      return urls.value.every((url) => !inFlight.has(url));
    }),
}));

/** Mark URLs as awaiting an answer. */
function setInFlight(...urls: string[]): void {
  for (const url of urls) inFlight.add(url);
  flightBump.value++;
}

/** Deliver an answer into the ref the component is already watching. */
function answer(p: LinkPreview): void {
  entryRef(p.url).value = p;
  inFlight.delete(p.url);
  flightBump.value++;
}

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

// ⚠ TOP-LEVEL, not inside `seedSettings`. The ref cache lived there and so was skipped by the one
// test that builds its own Pinia (it needs `image_modal` off), which then rendered the PREVIOUS
// test's refs — its own `resolved.set` calls were dead, and planting a null ref made it crash on
// an undefined element rather than fail its stated assertion.
beforeEach(() => {
  refs.clear();
  inFlight.clear();
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
    // ⚠ ...and NOT the site or author. `siteName` and `author` stay on the wire — iOS may want
    // them, and the hostname fallback is computed server-side — but the web card doesn't spend a
    // line on naming a URL that is already in the message a word above it.
    expect(wrapper.text()).not.toContain('YouTube');
    expect(wrapper.text()).not.toContain('Maslow Unknown');
  });

  it('gives a video the player box whatever shape its thumbnail is', () => {
    // ⚠ The layout rule below is about SHARE IMAGES. A video's box is the player's geometry —
    // an iframe replaces it — so a square oEmbed thumbnail must not talk it into the small
    // square, which would leave the play control in a 72px box and the video effectively gone.
    const wrapper = mount(MessageAttachment, {
      props: { preview: preview({ ...YOUTUBE, thumbWidth: 480, thumbHeight: 480 }) },
    });
    expect(wrapper.find('.card-media .card-play').exists()).toBe(true);
    expect(wrapper.find('.card-thumb').exists()).toBe(false);
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

  it('sends the origin to the player, because no-referrer breaks every video', async () => {
    // ⚠⚠ This looks like a privacy REGRESSION and is the opposite: it is what makes the player
    // work at all. YouTube's embedded player validates the embedding page from the `Referer`
    // header, and `referrerpolicy="no-referrer"` — which this shipped with — meant every video
    // answered "Error 153, Video player configuration error" instead of playing. Proven by A/B:
    // two iframes, same embed URL, same `allow`, differing only in this attribute.
    //
    // So the assertion is on the exact value, not on "some policy is set". `origin` sends
    // `scheme://host` and never the path, and the property that does the real privacy work is
    // the facade — nothing reaches the video host until the reader presses play, which the two
    // tests above guard.
    const wrapper = mount(MessageAttachment, { props: { preview: YOUTUBE } });
    await wrapper.find('.card-play').trigger('click');
    expect(wrapper.find('iframe').attributes('referrerpolicy')).toBe('origin');
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
    // The thumbnail survives — as an ordinary page card's image, and YOUTUBE declares no
    // dimensions, so it takes the small square. See the layout suite below.
    expect(wrapper.find('.card-thumb').attributes('src')).toBe('/api/link-preview/media/tok');
    expect(wrapper.find('.card-title').attributes('href')).toBe(YOUTUBE.url);
  });

  it('keeps the box, and the play control, for a video with no thumbnail at all', () => {
    // ⚠ The box is gated on `isVideo` alone and must stay that way: an oEmbed reply carrying a
    // title but no thumbnail_url (or an og:image `normalizeUrl` refused) leaves `thumb` undefined
    // with `embedUrl` set. Gating the block on the thumbnail instead put the card in a state with
    // no branch true at all — a title, and a video that could never be played.
    const wrapper = mount(MessageAttachment, {
      props: { preview: preview({ ...YOUTUBE, thumb: undefined }) },
    });
    expect(wrapper.find('.card-media').exists()).toBe(true);
    expect(wrapper.find('.card-play').exists()).toBe(true);
    expect(wrapper.find('.card-thumb-wide').exists()).toBe(false);
  });
});

describe('MessageAttachment — the two card shapes', () => {
  beforeEach(() => seedSettings());

  // #692 items 2 and 3. A card is a small square beside its text, or text on its own.
  //
  // ⚠⚠ A THIRD shape — the landscape band under the text, Discord's large embed — was built and
  // removed after looking at it on real links. Its tests are gone with it, but the property they
  // were really guarding survives here: whatever shape a card takes, it must take it from the
  // DESCRIPTOR and not from the image. Measuring the picture on load would make the layout depend
  // on bytes, so every card would lay out once and re-arrange on decode (R1).
  //
  // ⚠ The LINE BUDGET half of #692 (title 2, description 3) is pure CSS with no class binding to
  // observe, and happy-dom applies no stylesheet — so there is deliberately no test for it here
  // rather than one that would stay green with every clamp deleted.

  const page = (over: Partial<LinkPreview> = {}) =>
    preview({
      url: 'https://news.example/article',
      kind: 'page',
      title: 'A headline',
      description: 'A standfirst.',
      thumb: '/api/link-preview/media/tokP',
      ...over,
    });

  it('puts the image beside the text as a small square, whatever shape it is', () => {
    // ⚠ The dimensions here are GitHub's real 1200x600 — a landscape share image, and once the
    // trigger for the band. They must change nothing now: a shape that varies per link is
    // exactly what was removed, and a descriptor field nothing reads is the easiest thing in the
    // world to start reading again by accident.
    const wide = mount(MessageAttachment, {
      props: { preview: page({ thumbWidth: 1200, thumbHeight: 600 }) },
    });
    const square = mount(MessageAttachment, {
      props: { preview: page({ thumbWidth: 512, thumbHeight: 512 }) },
    });
    const undeclared = mount(MessageAttachment, { props: { preview: page() } });

    for (const wrapper of [wide, square, undeclared]) {
      expect(wrapper.find('.card-thumb').attributes('src')).toBe('/api/link-preview/media/tokP');
      // Not the player's box either, which is the only ratio-reserved block left.
      expect(wrapper.find('.card-media').exists()).toBe(false);
      // Text leads, in source order — nothing is re-ordered visually.
      const kids = [...wrapper.find('.card').element.children].map((el) => el.className);
      expect(kids).toEqual(['card-text', 'card-thumb']);
    }
  });

  it('degrades to text only when the card has no image', () => {
    // ⚠ `pageRecord` returns ok on a title OR an image, so this is an ordinary answer and not an
    // edge case. Reserving the square regardless would leave an empty box beside the text —
    // furniture for a picture that is never coming.
    const wrapper = mount(MessageAttachment, { props: { preview: page({ thumb: undefined }) } });
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.text()).toContain('A headline');
    expect(wrapper.find('.card-thumb').exists()).toBe(false);
  });

  it('renders no text block for a card that is only an image', () => {
    // The other half of the same asymmetry: an og:image with no og:title. An empty `.card-text`
    // still costs the card's gap, so it would carry a stray band beside its picture.
    const wrapper = mount(MessageAttachment, {
      props: { preview: page({ title: undefined, description: undefined }) },
    });
    expect(wrapper.find('.card-thumb').exists()).toBe(true);
    expect(wrapper.find('.card-text').exists()).toBe(false);
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

describe('MessageAttachments — atomic reveal', () => {
  // The rule: no layout may depend on WHEN A SIBLING RESOLVES. A message with two image URLs, one
  // of them already cached from an earlier post, used to paint as a lone image and then
  // re-arrange into a filmstrip when the second landed — and `stripHeight` re-picked
  // portrait-vs-landscape as the mix changed. Both moved a scrolled-up reader with no way to
  // compensate, because the growth had already happened by the time anything heard about it.

  beforeEach(() => resolved.clear());

  const img = (n: number, w = 800, h = 600) =>
    preview({
      url: `https://e.test/${n}.png`,
      kind: 'image',
      src: `/api/link-preview/media/t${n}`,
      thumbWidth: w,
      thumbHeight: h,
    });

  const TWO = 'https://e.test/1.png https://e.test/2.png';

  it('shows nothing while a sibling is still in flight, then the whole block at once', async () => {
    // ⚠ The FIRST assertion is the one that bites: without the gate this renders a lone
    // `.inline-image`, which is the arrangement that then flips.
    resolved.set(img(1).url, img(1));
    seedSettings();
    setInFlight(img(2).url);
    const wrapper = mount(MessageAttachments, { props: { text: TWO } });
    expect(wrapper.find('.attachments').exists()).toBe(false);
    expect(wrapper.find('.inline-image').exists()).toBe(false);

    answer(img(2));
    await nextTick();

    expect(wrapper.find('.filmstrip').exists()).toBe(true);
    expect(wrapper.findAll('.filmstrip img')).toHaveLength(2);
  });

  it('decides the strip height once, from the complete group', async () => {
    // ⚠ TWO portraits arrive first, so that without the gate there IS a filmstrip mid-flight — at
    // 300px, the whole-group-portrait height — which then collapses to 200px when the rest land.
    // An earlier draft seeded ONE image and passed with the gate reverted, because one image is
    // never a filmstrip either way. Two of four portrait is landscape ("primarily portrait" is
    // `portrait * 2 > length`), so the complete group is a 200px row.
    resolved.set(img(1, 600, 900).url, img(1, 600, 900));
    resolved.set(img(2, 500, 1000).url, img(2, 500, 1000));
    seedSettings();
    setInFlight(img(3).url, img(4).url);
    const wrapper = mount(MessageAttachments, {
      props: { text: `${TWO} https://e.test/3.png https://e.test/4.png` },
    });
    expect(wrapper.find('.filmstrip').exists()).toBe(false);

    answer(img(3, 1200, 500));
    answer(img(4, 1000, 400));
    await nextTick();

    expect(wrapper.find('.filmstrip').attributes('style')).toContain('200px');
  });

  it('does not stall on a URL no answer is coming for', () => {
    // ⚠⚠ The property the whole gate rests on, and the reason it asks the module rather than
    // running a timer. `useLinkPreview` hands back a permanently-null ref for a URL nobody primed,
    // so a gate of "every entry has a value" would blank this message for the life of the tab.
    // Not in flight means not coming, and the block renders now.
    //
    // ⚠ This one does NOT fail if the gate is deleted, and it CANNOT observe the pending rule
    // itself — this suite mocks `usePreviewsSettled`, so mutating `previewPending` leaves it
    // green. (Checked, after an earlier version of this comment claimed otherwise.) The real rule
    // is guarded in `useLinkPreview.test.ts` → "is an answer still coming?", where all three of
    // its clauses are revert-proven. What this asserts is the component half: that a settled-but-
    // valueless URL is rendered past rather than waited on.
    resolved.set(img(1).url, img(1));
    seedSettings();
    const wrapper = mount(MessageAttachments, { props: { text: TWO } });
    expect(wrapper.find('.inline-image').exists()).toBe(true);
  });

  it('does not hide a block already on screen when a URL goes back in flight', async () => {
    // A transient failure is re-asked (`runReask` re-queues it), which puts a settled URL back
    // into the pending set. Un-revealing would be a SHRINK, which disturbs a reader exactly as
    // much as the growth this gate exists to prevent.
    resolved.set(img(1).url, img(1));
    resolved.set(img(2).url, img(2));
    seedSettings();
    const wrapper = mount(MessageAttachments, { props: { text: TWO } });
    expect(wrapper.find('.filmstrip').exists()).toBe(true);

    setInFlight(img(2).url);
    await nextTick();

    expect(wrapper.find('.filmstrip').exists()).toBe(true);
  });

  it('survives an unrelated settings write while a URL is back in flight', async () => {
    // ⚠⚠ `urls` is a computed that allocates a fresh array every evaluation, and it re-evaluates
    // on ANY settings write, because the store replaces `values` wholesale. Watching the array
    // IDENTITY therefore fired the re-gate on a byte-identical URL list — so toggling the channel
    // list, or a highlight sound, or a cross-device sync, re-derived `revealed` from a `settled`
    // that can legitimately be false and made a strip vanish mid-read. That is the same shrink
    // the latch exists to prevent, reintroduced by the line meant to scope it.
    resolved.set(img(1).url, img(1));
    resolved.set(img(2).url, img(2));
    seedSettings();
    const wrapper = mount(MessageAttachments, { props: { text: TWO } });
    expect(wrapper.find('.filmstrip').exists()).toBe(true);

    // A cache eviction plus a repost re-primes a URL against a fresh null ref, so `settled` goes
    // false again under a latch that is holding the strip on screen.
    setInFlight(img(2).url);
    // ...and now something entirely unrelated writes a setting.
    useSettingsStore().values = {
      ...useSettingsStore().values,
      'chat.highlight_sound.enabled': true,
    };
    await nextTick();

    expect(wrapper.find('.filmstrip').exists()).toBe(true);
  });

  it('shows a URL added by a settings flip that was ALREADY resolved', async () => {
    // ⚠⚠ `shown` grows inside a watcher on `settled`, and Vue only runs that when the VALUE
    // changes. If the flip adds a URL that is already in the cache — the same image posted
    // earlier in the session, or previewed in another buffer — `settled` is true before and true
    // after, so the watcher never fires and the URL is never admitted. The attachment then stays
    // hidden for the life of the row, with everything about it resolved and ready.
    const CARD = 'https://news.example/article';
    resolved.set(CARD, preview({ url: CARD, kind: 'page', title: 'A page' }));
    resolved.set(img(1).url, img(1));
    seedSettings({ inlineMedia: false, linkPreviews: true });
    const wrapper = mount(MessageAttachments, {
      props: { text: `https://e.test/1.png ${CARD}` },
    });
    expect(wrapper.find('.card').exists()).toBe(true);
    expect(wrapper.find('.inline-image').exists()).toBe(false);

    // Nothing goes in flight: the image was resolved all along, it simply wasn't previewable.
    useSettingsStore().values['chat.inline_media.enabled'] = true;
    await nextTick();

    expect(wrapper.find('.inline-image').exists()).toBe(true);
    expect(wrapper.find('.card').exists()).toBe(true);
  });

  it('holds back only the NEW URLs when a settings flip grows the set', async () => {
    // ⚠⚠ The one path that changes `urls` without remounting: `/set` from the composer, or a
    // settings sync from another device. Two things have to be true at once here, and an earlier
    // version got the second exactly backwards.
    //
    //   1. The newly-previewable image must NOT paint until it has settled — otherwise the flip
    //      renders it piecemeal, which is what the gate exists to prevent.
    //   2. The card that was ALREADY on screen must stay on screen. Re-deriving one shared
    //      `revealed` flag from `settled` tore the whole block down instead: ten resolved cards
    //      collapsing buffer-wide, ~1200px of uncompensated shrink, for a setting about images.
    const CARD = 'https://news.example/article';
    resolved.set(CARD, preview({ url: CARD, kind: 'page', title: 'A page' }));
    seedSettings({ inlineMedia: false, linkPreviews: true });
    const wrapper = mount(MessageAttachments, {
      props: { text: `https://e.test/1.png ${CARD}` },
    });
    expect(wrapper.find('.card').exists()).toBe(true);

    setInFlight(img(1).url);
    useSettingsStore().values['chat.inline_media.enabled'] = true;
    await nextTick();

    expect(wrapper.find('.inline-image').exists()).toBe(false);
    expect(wrapper.find('.card').exists()).toBe(true);

    answer(img(1));
    await nextTick();
    expect(wrapper.find('.inline-image').exists()).toBe(true);
    expect(wrapper.find('.card').exists()).toBe(true);
  });
});

describe('MessageAttachment — a box that does not depend on bytes', () => {
  beforeEach(() => seedSettings());

  // ⚠ These assert the CLASS BINDING, which is the load-bearing logic; the height itself is CSS
  // and happy-dom applies no stylesheet. Stated rather than implied, because a test that can't
  // observe what it names is the trap this feature has already been caught by once.

  const unmeasured = preview({
    url: 'https://e.test/exotic',
    kind: 'image',
    src: '/api/link-preview/media/tokX',
  });

  it('reserves the box on a WRAPPER, and only for an unmeasured image outside a strip', () => {
    // ⚠ All three cases in ONE test, deliberately. Split apart, the two negative cases asserted
    // `not.toContain(...)` and stayed green with the binding deleted entirely — vacuous against
    // the very mutation they look like they guard.
    //
    // `imageDimensions` returns null for a format sharp can't parse in the 64 KB it reads — ico
    // and bmp both arrive as `kind: 'image'` with null dimensions. With no width/height attributes
    // there is no ratio to reserve a box from, so the element lays out at the UA default and grows
    // on decode: video's pre-465f838 bug, still live for images.
    //
    // ⚠⚠ The height is on the WRAPPER and that is the assertion that matters. Pinned on the
    // `<img>`, the empty letterbox around a 16x16 favicon became part of a 240px-tall control
    // that calls `stopPropagation` — swallowing the row tap that is the only opener of the
    // message-actions sheet on touch. A wrapper with no handlers leaves those pixels to the row.
    const lone = mount(MessageAttachment, { props: { preview: unmeasured } });
    expect(lone.find('.dim-reserve').exists()).toBe(true);
    expect(lone.find('.dim-reserve img.inline-image').exists()).toBe(true);

    // A measured image keeps its own aspect — the descriptor arrives atomically with the decision
    // to render at all, so natural aspect costs nothing and a fixed box would only waste space.
    const measured = mount(MessageAttachment, { props: { preview: IMAGE } });
    expect(measured.find('.dim-reserve').exists()).toBe(false);

    // In a strip the row already decides the height; a second fixed box would fight it.
    const strip = mount(MessageAttachment, { props: { preview: unmeasured, inStrip: true } });
    expect(strip.find('.dim-reserve').exists()).toBe(false);
    expect(strip.find('img').classes()).toContain('strip-item');
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
