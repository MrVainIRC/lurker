<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <!-- Direct media: no card, no chrome. A frame around an image is furniture around content. -->
  <!-- ⚠⚠ THE RESERVER IS THIS SPAN, ALWAYS — never the `<img>`, and never its width/height
       attributes. Those attributes were believed to reserve the box "BEFORE any bytes arrive";
       measured in both engines against a `src` that never resolves, they do not:

         Safari   pending 319x240   loaded 319x240
         Chrome   pending   0x0     loaded 319x240      (attrs 1841x1384)

       `.inline-image` sets `width: auto; height: auto` (below), which beats the attributes'
       presentational hints and leaves only the UA `aspect-ratio`. An `<img>` that has not loaded
       and carries `alt=""` "represents nothing" per HTML, and Blink honours that literally:
       no box at all. WebKit keeps one from the ratio, which is the whole of lurker#705 — every
       inline image in Chrome jumped 0 -> 240px at DECODE time, long after the atomic reveal's
       `previewRevision` re-pin had run, so a buffer opened at the tail landed 240px short of it.

       So the wrapper carries the geometry for every untiled image, derived from the server's
       dimensions rather than from bytes: `reserveStyle` resolves to exactly the box the loaded
       image occupies. In a mosaic the cell's fixed size governs and the wrapper stays out of the
       way — see `dim-passthrough`.

       ⚠ Geometry on the WRAPPER also keeps the empty letterbox out of the image: pinned on the
       `<img>`, a 16x16 favicon.ico became a 240px-tall, full-column-wide element carrying
       `role="button"` and a handler that calls `stopPropagation`, so a tap anywhere in the ~99%
       of it that is background opened the lightbox AND swallowed the row click — which on touch
       is the only thing that opens the message-actions sheet. A wrapper has no handlers, so those
       pixels keep belonging to the row. Same defect class as the `@click.stop` note below. -->
  <span
    v-if="preview.kind === 'image' && preview.src"
    :class="tiled ? 'dim-passthrough' : hasDimensions ? 'dim-reserve' : 'dim-reserve dim-fallback'"
    :style="reserveStyle"
  >
    <img
      class="inline-image"
      :class="{ 'tile-item': tiled, 'in-reserve': !tiled }"
      :src="preview.src"
      :width="preview.thumbWidth || undefined"
      :height="preview.thumbHeight || undefined"
      alt=""
      loading="lazy"
      decoding="async"
      :role="viewerEnabled ? 'button' : undefined"
      :tabindex="viewerEnabled ? 0 : undefined"
      :aria-label="viewerEnabled ? imageLabel : undefined"
      @load="$emit('measured')"
      @click="onImageClick"
      @keydown.enter.prevent="activate"
      @keydown.space.prevent="activate"
    />
  </span>
  <!-- ⚠ `@loadedmetadata` matters more here than the image's `@load` does. The server measures
       dimensions for images only, so a video has NO width/height to reserve a box with and lays
       out at the UA default 300x150 until its metadata arrives — then jumps to full size. The
       resolve-time `previewRevision` has already fired by then, and the scroller's ResizeObserver
       watches its own box rather than its content, so without this nothing at all notices. -->
  <!-- ⚠ Never tiled. A player cropped into a grid cell loses its controls, which are the part
       that matters, so MessageAttachments stacks video and audio at full width and the mosaic
       is images only. -->
  <video
    v-else-if="preview.kind === 'video' && preview.src"
    class="inline-video"
    :src="preview.src"
    controls
    preload="metadata"
    @click.stop
    @loadedmetadata="$emit('measured')"
  />
  <audio
    v-else-if="preview.kind === 'audio' && preview.src"
    class="inline-audio"
    :src="preview.src"
    controls
    preload="metadata"
    @click.stop
    @loadedmetadata="$emit('measured')"
  />

  <!-- A page, or a video page. Discord's panel treatment: the card sits on its own slightly
       raised background so it reads as a distinct object rather than as more chat text.
       TWO shapes: a small square beside the text, or text on its own. ⚠ A landscape image under
       the text — Discord's large-embed form, and what this component briefly did — was built,
       run against real links and rejected on looking at it: the picture dominates the message
       rather than annotating it, and a 240px band per link turns a few pasted URLs into a page
       of somebody else's pictures. The square annotates, which is what a preview is for.
       ⚠ No site/author LINE. Discord doesn't have one and it was the least useful line on the
       card: the URL it names is already in the message, a word above it. The site name is still
       what the card falls back to when a page has no title — see `heading`. -->
  <div
    v-else
    class="card"
    :class="{ 'card-video': isVideo, 'card-column': isVideo || cardShape === 'hero' }"
  >
    <!-- ⚠⚠ BOTH unconditional, and that is the fix for a whole class of empty card. `pageRecord`
         returns ok on a title OR an image, so `preview.title` is absent on ordinary answers —
         an og:image with no og:title, and the deliberately-degraded video record that keeps an
         embed URL after a rate-limited provider call. With the heading gated on `title` those
         rendered as a tinted panel containing a picture and nothing else, or nothing at all: no
         text, no ANCHOR, and no accessible name, since the thumbnail is `alt=""`. A preview that
         goes nowhere and names nothing still costs a card slot and a row of height.
         `heading` cannot be empty, so this element always exists and the card always links. -->
    <div class="card-text">
      <!-- ⚠ No `:title`. A previous round added one so a clamped heading could still be read in
           full, and it cost more than it bought: on a link whose title fits it is a tooltip
           byte-identical to the text under it, and since a link takes its name from its content
           the attribute falls through to the accessible DESCRIPTION and is announced twice. It
           also does nothing where the clamp actually bites — the narrow viewport this card has a
           media query for is the one with no hover at all. -->
      <a
        class="card-title"
        :href="preview.url"
        target="_blank"
        rel="noreferrer noopener"
        @click.stop
        >{{ heading }}</a
      >
      <div v-if="preview.description" class="card-desc">{{ preview.description }}</div>
    </div>

    <!-- ⚠ Gated on isVideo alone, NOT on having a thumbnail. `pageRecord` returns ok as soon as
         there is a title OR an image, so an oEmbed reply with a title but no thumbnail_url (or
         an og:image that normalizeUrl rejected) yielded embedUrl set and thumb undefined — both
         this branch and the `v-else-if="preview.thumb"` one were false, so the card showed a
         title with the ▶, and the whole video, unreachable. A video keeps its box with no
         thumbnail because the box is what the play control lives in; a PAGE with no image has
         nothing to put in one and renders none — see below. -->
    <div v-if="isVideo" class="card-media">
      <!-- THE FACADE. The iframe does not exist until this is clicked, so nothing is requested
           from the video host on render — not even the thumbnail, which is proxied through us
           like every other preview image. The first request the viewer makes to YouTube is the
           one they asked for by pressing play. -->
      <!-- ⚠⚠ `origin`, NOT `no-referrer`, and this is the difference between a player and an
           error message. YouTube's embedded player validates the embedding page from the
           `Referer` header, and with none it refuses every video: **"Error 153 — Video player
           configuration error"**, for the whole life of this component. Proven by A/B rather
           than reasoned about — two iframes, same embed URL, same `allow`, differing only in
           this attribute: `no-referrer` fails and `origin` plays.
           ⚠ It is a REAL trade, not a free one, and an earlier version of this comment claimed
           otherwise ("the embed request tells them anyway"). It does not: an iframe `src` load
           is a navigation, so no `Origin` header is appended, and under `no-referrer` the
           provider genuinely could not identify the embedding host. After this it learns
           `scheme://host` — which for a self-hosted instance can itself be identifying. What is
           bought is the feature existing at all, and what is NOT given up is the path: never
           which channel, which buffer, or which message.
           ⚠ `origin` rather than `strict-origin` because `origin` is the value the A/B actually
           measured. An earlier version of this comment justified the choice by claiming they
           differ on an http page, with `strict-origin` sending nothing — that is backwards.
           Referrer Policy suppresses only on a DOWNGRADE (secure → insecure), and both
           EMBED_ORIGINS are https, so an http LAN page framing them is an upgrade and the two
           values are byte-identical in every configuration reachable today. `strict-origin` is
           the safer default the moment a non-https embed origin is ever added; it is not adopted
           here on the strength of a spec reading, because a spec reading is what produced the
           sentence this one replaces.
           The privacy property doing the real work is the facade above: nothing at all is
           requested from the video host until the reader asks for it. -->
      <iframe
        v-if="playing"
        ref="embedEl"
        class="card-embed"
        :src="preview.embedUrl"
        :title="`${heading} — video player`"
        allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
        referrerpolicy="origin"
        allowfullscreen
      ></iframe>
      <!-- ⚠ Named from `heading`, not from `preview.title`. The record `heading` exists for — the
           degraded embed with no title at all — is exactly the one whose control was called
           "Play video", so two rate-limited YouTube links in a buffer presented two
           identically-named buttons: the defect `imageLabel` is written to prevent, on the
           element next to it. (`?? 'video'` also let a wire `title: ''` name it "Play ";
           `heading`'s truthiness ladder falls through.) -->
      <button
        v-else
        type="button"
        class="card-play"
        :aria-label="`Play ${heading}`"
        @click.stop="play"
      >
        <img
          v-if="preview.thumb"
          class="card-thumb-wide"
          :src="preview.thumb"
          alt=""
          loading="lazy"
        />
        <span class="play-badge" aria-hidden="true">▶</span>
      </button>
    </div>
    <!-- THE HERO. A full-width band under the text, Discord's large-embed shape, and the default
         for any card whose picture is not a logo — see `cardShape`.
         ⚠⚠ A FIXED box with the image fitted inside it, rather than a box derived from the
         image. `og:image:width`/`og:image:height` are DECLARED, not measured: a page can lie,
         omit one of the pair, or describe an image it isn't sending. Sizing the band from those
         numbers would put a card's height at the mercy of a stranger's markup — and R1 says no
         layout may depend on bytes, so the alternative (read the real ratio at decode) is not
         available either. One box the whole app agrees on cannot be wrong about anything; the
         declared shape is used only to CHOOSE between the two shapes, never to size one.
         ⚠ `contain`, not `cover`: 1200x630 is a convention rather than a rule, and a 4:3 or a
         portrait share image cropped to a 1.9:1 band loses its subject. Letterboxed against the
         card's own panel it merely sits in a wider frame. -->
    <div v-else-if="cardShape === 'hero'" class="card-hero">
      <img class="card-hero-img" :src="preview.thumb" alt="" loading="lazy" decoding="async" />
    </div>
    <!-- ⚠ NO block at all without an image, rather than an empty square. A card is `ok` on a
         title OR an image, so a title-only card is an ordinary answer — and a reserved box with
         nothing coming is furniture. -->
    <img
      v-else-if="cardShape === 'square'"
      class="card-thumb"
      :src="preview.thumb"
      alt=""
      loading="lazy"
      decoding="async"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from 'vue';
import type { LinkPreview } from '../composables/useLinkPreview.js';
import { useSettingsStore } from '../stores/settings.js';

// Purely presentational: it renders ONE already-resolved, already-permitted preview.
// Resolution happens at message ingest and the settings check happens in
// MessageAttachments, which needs the resolved set anyway to decide the arrangement.
const props = defineProps<{
  preview: LinkPreview;
  /** A mosaic cell: sized by the grid rather than by its own dimensions, and cropped to fill. */
  tiled?: boolean;
}>();

// ⚠⚠ `measured` is emitted by IMAGE, VIDEO and AUDIO. The image `@load` emit was removed once,
// on the reasoning that "every rendered image now has its box before any bytes" and so `@load`
// could no longer report growth — the cost cited was five idempotent scroll corrections for a
// five-image message. The premise was false in Blink (see the template: pending 0x0), the
// removal took away the only thing that would have NOTICED, and lurker#705 is what that cost.
//
// It is back as a NET, and it is kept even though `reserveStyle` should now make it redundant.
// A correction while pinned is `scrollTop = scrollHeight` — idempotent, invisible, and cheap
// enough that "this growth cannot happen" is not worth betting a scroll position on. The guard
// that makes it safe lives in the list: `repinAfterPreviewGrowth(true)` returns immediately
// unless the reader is at the tail, so a scrolled-up reader is never moved by a late decode.
// `activate` rather than opening the viewer here: what a click MEANS depends on the
// arrangement, and the arrangement is the parent's business. A tap on one tile of a mosaic
// should open the whole message's images as a gallery — including the ones the mosaic capped
// away — and only the parent knows what those are.
const emit = defineEmits<{ measured: []; activate: [] }>();

const settings = useSettingsStore();
const playing = ref(false);
const embedEl = useTemplateRef<HTMLIFrameElement>('embedEl');

const isVideo = computed(() => props.preview.kind === 'video-embed' && !!props.preview.embedUrl);

/**
 * What the card is called, and what its link says. Never empty.
 *
 * ⚠⚠ The guarantee is the point. `pageRecord` returns `ok` on a title OR an image, so a card
 * without a title is an ordinary answer rather than an edge case — an og:image with no og:title,
 * a paywalled article that ships a description and no heading, and the deliberately-degraded
 * video record that survives a rate-limited provider call with nothing but an embed URL. Each of
 * those rendered as a panel with no anchor in it at all: a preview that goes nowhere, looks
 * finished, and (with an `alt=""` thumbnail) presents to a screen reader as an empty div.
 *
 * `siteName` is the fallback because the SERVER already guarantees it — `pageRecord` clamps
 * `providerName || og:site_name || url.hostname`, so it is non-null for every ok card, and that
 * hostname fallback exists precisely to be the thing a card can always show. The URL is parsed
 * here as a third rung anyway: a descriptor is a wire value, and a client that depends on a
 * server invariant should be able to survive its absence rather than render blank.
 *
 * ⚠ This is NOT the site line coming back. There is no separate row for it — when a page has a
 * title, that is the whole heading and the hostname appears nowhere.
 *
 * ⚠ `hostname`, NOT `host`, and the difference is the PORT. This rung is a backstop for the
 * server's own last resort, so it has to produce the same string the server would: `pageRecord`
 * clamps `url.hostname`, and `host` appends `:8096` to it. Otherwise one card is named
 * `nas.local` or `nas.local:8096` depending on which rung happened to fire — two spellings of one
 * site, from the same URL, which is the disagreeing-parsers class this feature has a rule about.
 * Self-hosted and LAN links are exactly where a non-default port is ordinary. (Copilot.)
 */
const heading = computed(() => {
  const p = props.preview;
  if (p.title) return p.title;
  if (p.siteName) return p.siteName;
  try {
    return new URL(p.url).hostname || p.url;
  } catch {
    // A URL that won't parse is still a string worth showing over an empty card.
    return p.url;
  }
});

/**
 * Which of the two card layouts this preview gets, from the DECLARED shape of its image.
 *
 * ⚠⚠ HISTORY, because this reverses a decision and the evidence is the expensive part. A
 * landscape band was built once, run against real links, and REJECTED on looking at it: "a 240px
 * picture per link reads as the message rather than as a note about it". What made that verdict
 * fair at the time was that it fired almost at random — `imageWidth`/`imageHeight` were only ever
 * populated from an oEmbed thumbnail, so for an ordinary og:image card they were NULL and the
 * choice fell through to a default. `scrapeMeta` reads `og:image:width`/`og:image:height` now
 * (resolver v4), so the rule finally has the input it always assumed it had.
 *
 * Measured from the live markup, twice, a week apart:
 *
 *   reddit.com, /r/irc     256x256     square  — the case this exception exists for
 *   Ars Technica           512x512     square  — a LOGO
 *   Wikipedia              869x1200    square  — portrait; a hero band would crop its subject out
 *   GitHub                 1200x600    hero
 *   firecore.com/infuse    1200x630    hero
 *   bradroot.me            undeclared  hero    — by the default below
 *   NYT, BBC               undeclared  hero    — by the default below
 *
 * ⚠⚠ HERO IS THE DEFAULT when nothing is declared, and the trade is deliberate. The undeclared
 * population is mostly editorial (NYT, BBC), which is exactly what wants a hero; the cost is that
 * an undeclared square logo gets letterboxed in a wide frame. `contain` is what makes that cost
 * survivable — the logo is small and centred rather than cropped into a band.
 *
 * ⚠⚠ `twitter:card` is NOT consulted, and it is the obvious thing to reach for. It is the
 * author's stated INTENT and it disagrees with the author's own picture in exactly the direction
 * that produces the bad result: Ars Technica declares `summary_large_image` beside that 512x512
 * logo. Re-verified against live markup while writing this. Declared dimensions can be wrong too,
 * but they are wrong about the thing they describe rather than about something else.
 *
 * ⚠ Reading `naturalWidth` on load would be accurate and is the one thing this component may not
 * do: the layout would then depend on bytes and every card would re-arrange on decode, which is
 * R1, the rule the rest of this file exists to keep.
 *
 * Not consulted for a video — `isVideo` claims that branch first, because a player's box is the
 * embed's geometry rather than a choice about a picture.
 */
const SQUARE_MAX_RATIO = 1.3;

const cardShape = computed<'hero' | 'square' | 'none'>(() => {
  // A card is `ok` on a title OR an image, so having no picture at all is an ordinary answer.
  if (!props.preview.thumb) return 'none';
  const w = props.preview.thumbWidth;
  const h = props.preview.thumbHeight;
  // ⚠ Square AND portrait both take the chip. The threshold sits just under 4:3 (1.333), so a
  // conventional photo is a hero and anything approaching square is not — the shapes that read
  // as "this is an icon of the site" rather than "this is a picture of the thing".
  if (w && h && w / h < SQUARE_MAX_RATIO) return 'square';
  return 'hero';
});

/**
 * Whether the server could measure this image.
 *
 * `imageDimensions` fails legitimately and not rarely: an exotic format, or a header sharp can't
 * parse inside the 64 KB it reads — ico and bmp both arrive as `kind: 'image'` with null
 * dimensions. Measured or not, the box is reserved either way; this only picks WHICH box.
 */
const hasDimensions = computed(() => !!props.preview.thumbWidth && !!props.preview.thumbHeight);

/** The tallest a lone image gets. Mirrors `.inline-image`'s `max-height`, and `.dim-fallback`. */
const MAX_IMAGE_HEIGHT = 240;

/**
 * The box this image will occupy, resolved from the server's dimensions instead of from bytes.
 *
 * Null in the two cases that must not carry geometry: inside a mosaic, where the cell's fixed
 * size governs and a second box would fight it, and for an unmeasured image, which has no
 * ratio to derive one from and falls back to `.dim-fallback`'s flat height.
 *
 * ⚠⚠ The HEIGHT CAP IS APPLIED AS A WIDTH, and that is what makes this exact rather than
 * approximate. `max-height` cannot bite until the natural width is known — it is the reason the
 * loaded box (319x240) is one no pre-load layout could have guessed — so the same cap, applied to
 * the width as `MAX_IMAGE_HEIGHT * ratio`, reproduces the post-load result with no bytes:
 *
 *   width  = min(naturalWidth, MAX_IMAGE_HEIGHT * ratio)   here
 *   width  = min(that, 100%)                               via `.dim-reserve`'s `max-width`
 *   height = width / ratio                                 via `aspect-ratio`
 *
 * Each term is a constraint that would otherwise be discovered late: `naturalWidth` stops a 16x16
 * favicon being upscaled to a blurry 240px, the cap holds a portrait shot, and `max-width` clamps
 * a wide one to the column — with `aspect-ratio` carrying the height down with it, so a narrow
 * viewport stays exact too.
 *
 * ⚠ The column term is a SEPARATE `max-width` declaration rather than a third argument to a CSS
 * `min()`, which is what this returned first. `min()` is universally supported and would have
 * worked in every browser — but happy-dom's style parser drops a declaration it can't parse, so
 * the assertion in MessageAttachment.test.ts saw an empty width and could not have failed if the
 * binding were deleted. Two plain declarations are observable by the test that guards them.
 */
const reserveStyle = computed(() => {
  if (props.tiled || !hasDimensions.value) return null;
  const w = props.preview.thumbWidth!;
  const h = props.preview.thumbHeight!;
  return {
    // ⚠⚠ FRACTIONAL, and never rounded to a whole pixel. `aspect-ratio` derives the height by
    // DIVIDING this width by the ratio, so a rounding error is multiplied by `h / w` — and for the
    // shapes the cap exists to hold, that multiplier is enormous. Measured: a 13x1200 sliver's
    // exact 2.6px width rounds to 3px and the box becomes 277px tall; a 2x1000 one, floored to 1px
    // to keep it from rounding to 0, becomes **500px** — more than double the ceiling the rounding
    // was decorating. (No decode-time growth either way: the box is byte-independent whatever this
    // number is. What breaks is `MAX_IMAGE_HEIGHT` meaning anything.)
    //
    // A fractional width keeps the cap exact and makes the zero case unreachable in one move,
    // since `MAX_IMAGE_HEIGHT * (w / h)` is greater than zero for any real pair of dimensions —
    // so the floor that caused the 500px box is gone rather than tuned. Three decimals to keep the
    // attribute readable; the residual is `0.001 * h / w`, which is a tenth of a pixel on the
    // worst shape above. `Number()` drops the trailing zeros `toFixed` adds, so the ordinary case
    // stays `320px` rather than `320.000px`.
    width: `${Number(Math.min(w, MAX_IMAGE_HEIGHT * (w / h)).toFixed(3))}px`,
    aspectRatio: `${w} / ${h}`,
  };
});

/**
 * ⚠⚠ THERE IS DELIBERATELY NO `@error` HANDLING, and that is a decision rather than an omission.
 *
 * A version of this component tracked a `failed` flag to paint a panel fill instead of the UA's
 * broken-image glyph. Measured in three engines, it made things worse rather than better:
 *
 *   - Setting a non-empty `alt` on failure re-triggers frame construction in Gecko and DROPS the
 *     attribute-derived aspect ratio, collapsing a measured 240px box to an 18px text line —
 *     222px of uncompensated shrink that plain `alt=""` does not suffer. (⚠ That measurement was
 *     taken when the `<img>` was the reserver. It no longer is — the wrapper holds the box and an
 *     `alt` swap cannot reach it — so this particular collapse is now structurally impossible.
 *     Kept as the record of why the flag was tried, not as a live constraint.)
 *   - The reset that was supposed to clear the flag could never fire: `mintProxyToken` is an HMAC
 *     over the URL, so a re-delivered answer carries a byte-identical `src` and the watch on it
 *     never runs. And an `ok` preview is never re-asked at all, so the flag was permanent — a
 *     two-second network blip greyed out every inline image for the life of the row.
 *   - Dropping `role`/`tabindex` on failure removed them from an element that may currently HOLD
 *     focus, dumping a keyboard user back to `<body>` mid-mosaic.
 *
 * The byte-independence rule this file serves is already satisfied without any of it, and since
 * lurker#705 it is satisfied MORE strongly than this paragraph used to claim: the reservation does
 * not depend on the image element at all — `.dim-reserve` holds the box for every untiled image,
 * from the descriptor, whether the bytes arrive or not. (The old claim, that "the width/height
 * attributes survive a failed load", was doubly wrong: those attributes reserve nothing once author
 * CSS sets `width: auto`, so what survived a failed load was nothing at all in Blink.)
 * A broken-image glyph in a correctly-sized box is a smaller problem than every one of the above.
 */

/**
 * Swap the facade for the real player.
 *
 * ⚠ The focus move is not a nicety. `v-if="playing"` unmounts the button that is
 * `document.activeElement` at the moment a keyboard user presses Enter on it, so focus falls to
 * `<body>` and the next Tab restarts at the top of the document — past every message above, and
 * never reaching the player they just opened. This file already names that failure in so many
 * words for a different case ("dumping a keyboard user back to `<body>` mid-mosaic"), which is
 * how it was noticed here.
 *
 * `nextTick` because the iframe does not exist until the re-render, and `?.` because a card
 * unmounted in the same tick (a re-render dropping the attachment) has nothing to focus.
 */
function play(): void {
  playing.value = true;
  void nextTick(() => embedEl.value?.focus());
}

// The viewer is opt-out (chat.image_modal.enabled); when it's off, an inline image is just an
// image. That has to be true of the EVENT too, not only of the outcome — see below.
const viewerEnabled = computed(() => settings.effective('chat.image_modal.enabled') === true);

/**
 * The accessible name for the image WHEN IT IS A CONTROL.
 *
 * ⚠ `alt=""` is right for a decorative image and stops being sufficient the moment `role="button"`
 * is applied: the img role that made an empty alt meaningful is gone, and what's left is a
 * focusable control with no name. Only set while the viewer is enabled, because that is the only
 * time this is a control at all — a plain inline image stays decoration of the message text,
 * which the surrounding link already names.
 *
 * The filename is included when the URL yields one, so a mosaic of four doesn't present four
 * identically-named buttons to anyone moving through them by keyboard.
 */
const imageLabel = computed(() => {
  let name = '';
  try {
    name = decodeURIComponent(new URL(props.preview.url).pathname.split('/').pop() ?? '');
  } catch {
    // A URL that won't parse just doesn't contribute a filename.
  }
  return name ? `Open image: ${name}` : 'Open image';
});

/**
 * ⚠ Propagation is stopped only when the click is actually being consumed.
 *
 * `@click.stop="openViewer"` compiles to `withModifiers(openViewer, ['stop'])`, and the
 * modifier runs BEFORE the handler — so with the media viewer switched off the tap was
 * swallowed and then discarded by the handler's own guard. On touch the row's click is the only
 * thing that opens the message-actions sheet (hover actions are desktop-only, and there is no
 * long-press or contextmenu path), so an image became a dead zone covering the largest target
 * in the row: no viewer, no sheet, nothing.
 */
function onImageClick(e: MouseEvent): void {
  if (!viewerEnabled.value) return;
  e.stopPropagation();
  emit('activate');
}

/** Keyboard equivalent. An element advertising `cursor: pointer` and a `button` role has to be
 *  reachable without one — matching RenderSegments, MircColorPicker and SuggestionStrip. */
function activate(): void {
  if (!viewerEnabled.value) return;
  emit('activate');
}
</script>

<style scoped>
.inline-image {
  max-width: 100%;
  /* Capped so one tall screenshot can't push the rest of the conversation off screen. The
     viewer is one click away for the full thing. */
  max-height: 240px;
  /* ⚠ Both `auto`, and both needed — for SCALING, which is all they were ever doing. They let the
     box shrink proportionally inside max-width/max-height; without `width: auto` a portrait image
     hits the height cap and keeps its attribute width, which is squashing rather than scaling.
     ⚠⚠ What they do NOT do, and were long claimed to do, is leave the width/height attributes
     free to reserve space: author styles beat presentational hints, so these two declarations are
     precisely why an unloaded image had no box in Blink. The reservation lives on the wrapper
     (see the template); these stay because a loaded image still has to fit the box it was given. */
  width: auto;
  height: auto;
  object-fit: contain;
  border-radius: var(--radius-md);
  display: block;
}
/* In a mosaic the CELL is the reservation, so the wrapper generates no box at all and the image
   becomes the tile's own child for layout. That is load-bearing rather than incidental:
   `.tile`'s clipping, rounding and overflow overlay all apply to the picture only because
   nothing boxed stands between them. */
.dim-passthrough {
  display: contents;
}
/* Everywhere else the wrapper IS the box. Measured images get their geometry inline from
   `reserveStyle` (a definite width plus `aspect-ratio`); `.dim-fallback` below covers the rest. */
.dim-reserve {
  display: block;
  /* The column clamp, and the third term of the box `reserveStyle` computes — kept here rather
     than inline because it is the one constraint that isn't knowable from the descriptor.
     `aspect-ratio` carries the height down with the width when it bites, so the box stays exact
     on a narrow viewport instead of only on a wide one. */
  max-width: 100%;
  /* ⚠ NO fill, deliberately. It had one — the reasoning was that a lazily-loaded empty box reads
     as a hole punched in the conversation. QA read it the other way round: a panel-coloured
     rectangle is what a link-preview CARD looks like, so an image that merely hadn't been
     measured announced itself as a different kind of object entirely. Direct media has no chrome
     anywhere else in this component, and reserved space is not a thing to advertise. */
}
/* No dimensions from the server means no ratio to derive a box from, so the one flat height that
   remains honest is the tallest a lone image gets. 240px matches `.inline-image`'s `max-height`
   and `MAX_IMAGE_HEIGHT`, so the fallback and the measured case agree on that ceiling. */
.dim-fallback {
  height: 240px;
}
/* Inside the reserve the image is bounded by the box and never scaled up. For a measured image
   the two agree exactly — `reserveStyle` derives the box from the same ratio the image decodes
   to — so this is what makes the arrival a no-op rather than a resize. For an unmeasured one it
   is a real constraint: sharp decodes jpeg/png/webp/tiff/gif/svg/heif/raw, so ico and bmp arrive
   as `kind: 'image'` with null dimensions, and a 16x16 favicon stretched to 240px would be 15x
   blurry. */
.inline-image.in-reserve {
  max-height: 100%;
  max-width: 100%;
  width: auto;
  height: auto;
}
/* Only advertises a click when a click does something — the viewer is opt-out. */
.inline-image[role='button'] {
  cursor: pointer;
}
.inline-video,
.inline-audio {
  max-width: 100%;
  width: auto;
  border-radius: var(--radius-md);
  display: block;
}
/* ⚠ A FIXED height, not a max. The server measures dimensions for images only, so a video has
   no intrinsic ratio to reserve a box from: it lays out at the UA default 300x150 and jumps to
   its real size when `loadedmetadata` fires. `@loadedmetadata` lets the list re-pin, but that is
   only a mitigation — the re-pin can follow the bottom and cannot hold a scrolled-up reader
   still, because by the time we hear about the growth it has already happened.
   Pinning the height removes the jump instead of compensating for it: the box is correct before
   a single byte arrives. Width still settles when the ratio is known, which costs nothing —
   only vertical movement disturbs a scroll position.

   ⚠⚠ 300px, half as much again as the 200px it replaced, and the reason is that THIS IS THE ONLY
   PLACE A VIDEO IS EVER WATCHED. The media viewer is images-only — `openAt` filters on
   `kind === 'image'`, because MediaViewerModal picks its element from the URL's extension and a
   proxy path has none, so a video handed to it mounts MP4 bytes in an `<img>` and fails. Discord
   is the same: its inline player has no lightbox behind it either. An image can afford to be a
   thumbnail because a click opens the real thing; a video at thumbnail size is just small.

   ⚠ The cost is on a narrow column, and it grows with this number. `max-width: 100%` clamps the
   width while this height stays put, so a 16:9 clip on a phone letterboxes — ~49px of bar top
   and bottom at 360px wide, where at 200px there was none. That is the thing to look at before
   raising this again. Accepted rather than fixed, because every fix trades it for something
   worse: `max-height` restores the 300x150 jump this rule exists to remove, and a fixed
   `aspect-ratio` box (the mosaic's trick) would letterbox every phone-shot VERTICAL video down
   its sides instead, which is the more common shape on IRC. Letting the width follow the real
   ratio is what makes a portrait clip render as a portrait clip. */
.inline-video {
  height: 300px;
}
.inline-audio {
  width: 100%;
}

/* A mosaic cell: fill it exactly, whatever shape the picture is.
   ⚠ All four of `.inline-image`'s sizing declarations have to be undone, not merely added to —
   `max-height: 240px` would letterbox a tile in the two-row layouts and `width/height: auto`
   would leave a portrait image sitting in a corner of its cell. `cover` is the whole bargain the
   mosaic makes: a uniform grid, laid out before any bytes arrive, at the price of a crop that
   any tap undoes by opening the full picture in the viewer. */
.tile-item {
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  object-fit: cover;
}

.card {
  display: flex;
  /* A row: text, then the square to the right of it. Text first in the DOM, so this is source
     order — nothing is re-ordered visually. `.card-video` below is the one exception. */
  gap: var(--space-4);
  align-items: flex-start;
  /* A raised panel, Discord-style, so the card reads as a distinct object rather than as more
     chat text. Doing the distinction with a background instead of a left rule is what lets the
     rule go away on desktop (below) without the card losing its edges.
     ⚠ --embed-bg, NOT --bg-soft: that's the message row's hover fill, and a card painted with
     it disappears the moment the pointer crosses its row. */
  background: var(--embed-bg);
  border-radius: var(--radius-md);
  /* ⚠ Deliberately more than the app's usual inset. Elsewhere `--space-4` separates things
     inside a dense list; here it is the margin of a PANEL, and at 8px the text sat on its edge
     and the thumbnail ran to it. The padding is what makes the card read as an object with
     content in it rather than as a tinted block. */
  padding: var(--space-6);
}
/* The Slack-style left rule is a MOBILE-only cue. On desktop the app already has a vertical
   border running down the side of the message column right next to this, and a second rule a
   few pixels away just reads as noise. On a narrow viewport that border isn't there, so the
   rule is doing real work. */
@media (max-width: 768px) {
  .card {
    border-left: 3px solid var(--border);
    /* The rule replaces the panel's own left padding rather than adding to it: 3px of border
       plus 10px lands within a pixel of the 12px the other three sides get, so the rule reads
       as the panel's edge rather than as a stripe with a gutter beside it. */
    padding-left: var(--space-5);
  }
}
/* The picture goes UNDER the text and full width — a video's facade, because a player reduced to
   a 72px square is not a player, and a hero image, because that is the shape being asked for.
   ⚠ For a video this is about the PLAYER, not the picture: an iframe replaces that box on the
   first click, so its 16:9 is the embed's geometry and not a choice about how to present an image.
   ⚠⚠ Load-bearing beyond the arrangement: without it the card stays a ROW, and the flex maths
   then deletes the text rather than shrinking the picture. `.card-text` is `flex: 1` (basis 0%)
   while the media box carries `width: 100%` (basis = the whole content box), so the bases
   already consume the line and the text resolves to 0px wide — title and description vanish
   behind their own `overflow: hidden`, with no overflow anywhere to hint at it. The class
   binding has a test for exactly this reason. */
.card-column {
  flex-direction: column;
  gap: var(--space-3);
}
.card-text {
  /* Takes the space the thumbnail doesn't, and `min-width: 0` is what lets it: a flex item's
     automatic minimum is its content, so a long unbroken title would otherwise push the square
     off the card instead of wrapping. */
  flex: 1;
  min-width: 0;
  /* The lines were flush against each other, separated by nothing but line-height, so a two-line
     title ran into its description and the block read as one paragraph. Hierarchy is on colour
     and weight (AGENTS.md: one font size), and spacing is the third thing that rule leaves
     available. */
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
/* ─── The line budget ──────────────────────────────────────────────────────────
   2 + 3, so a card's height is a small known set of values rather than one per link. Both fields
   are a stranger's markup: the server clamps them by CHARACTERS (MAX_TITLE 140,
   MAX_DESCRIPTION 300), which bounds the payload but not the height — 140 characters is one line
   or four depending on the viewport.
   ⚠ `line-clamp` is not `font-size`: the AGENTS.md rule forbids sizing text, and hierarchy here
   stays where it was, on colour and weight. */

/* Hierarchy by colour alone — AGENTS.md: one font size across the entire UI. */
.card-title {
  color: var(--accent);
  font-weight: 600;
  text-decoration: none;
  overflow-wrap: anywhere;
  /* ⚠⚠ Sized to its TEXT, not to the column. `-webkit-box` is block-level and this is a flex item
     of a column that never set `align-items`, so the default `stretch` made the anchor span the
     full width — and the anchor is now unconditional. On a card whose heading is a 12-character
     hostname that is a few hundred pixels of blank navigation target: a tap there opens a new tab
     (`target="_blank"`), and the row's own click never fires, which on touch is the only thing
     that opens the message-actions sheet. Same defect class this file records twice already, at
     the reserved-box wrapper and at `@click.stop`.
     Shrink-to-fit does not weaken the clamp: the width resolves to min(max-content, available),
     so a long heading still wraps at the column edge and still stops at two lines. */
  align-self: flex-start;
  /* Two lines. ⚠ `-webkit-box` REPLACES `display: block` rather than joining it — clamping is a
     property of that box type, so an anchor left inline (or set to block) ignores the clamp
     silently. */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-title:hover {
  text-decoration: underline;
}
.card-desc {
  color: var(--fg-muted);
  /* ⚠ Same break rule as the title, and for the same reason. `line-clamp` bounds LINES; it does
     nothing about a single token too wide for the column, which `overflow: hidden` then cuts
     mid-glyph with no ellipsis — the `…` only ever appears at a line boundary. An og:description
     is a stranger's markup bounded only by MAX_DESCRIPTION (300 chars), and a bare tracking URL
     or a German compound is one unbreakable token. */
  overflow-wrap: anywhere;
  /* Three lines: enough to tell what a page is, not enough to become the message. */
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* The hero band: a fixed box with the picture fitted inside it.
   ⚠⚠ The RATIO IS A CONSTANT, never derived from `thumbWidth`/`thumbHeight`. Those are numbers a
   stranger's page declared about a file we have not measured — a page can lie, ship one of the
   pair, or describe an image it is not serving — and a band sized from them puts a card's height
   at the mercy of that markup. Deriving it from the bytes instead is R1, which this file exists
   to keep. A constant box cannot be wrong: the declared shape only picks BETWEEN this and the
   chip, and a wrong pick is a letterboxed logo rather than a broken layout.
   1200x630 because that is the og:image convention the declaring half of the web targets, so the
   common case fills the frame exactly and nothing is bordered at all.
   ⚠ `contain`, not `cover`. The convention is not a rule — 4:3 and portrait share images are
   ordinary — and cropping one to a 1.9:1 band cuts the subject out. Fitted, it merely sits in a
   wider frame, against the card's own panel rather than the chat background. */
.card-hero {
  aspect-ratio: 1200 / 630;
  /* ⚠ NO width cap of its own — the card's 400px does the work (MessageAttachments), and the
     ratio carries the height down with it: ~197px against ~239px at the old 480. A cap here
     instead was tried and is worse in a way that only shows on screen, which is why it is
     recorded: a hero narrower than its own card sits against a band of empty panel, and that
     reads as a layout mistake rather than as a deliberately smaller picture. Height is not a
     handle either — capping it holds the box full-width and letterboxes a correctly-shaped
     image between two bars. Width is the only honest control, and it belongs to the card. */
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg);
}
/* ⚠⚠ Scoped to the column, exactly like `.card-video .card-media` below and for the identical
   reason: unscoped, a `width: 100%` basis beside `.card-text`'s 0% basis resolves the text to
   0px wide and deletes it. Expressed in the selector because happy-dom applies no stylesheet, so
   no test can observe it. */
.card-column .card-hero {
  width: 100%;
}
.card-hero-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}

/* The small square. ⚠ A fixed CSS box, so it reserves its own height with no dimensions and no
   decode — the same byte-independence the wide box gets from `aspect-ratio`. `cover` because a
   square hole is being cut out of something that may not be square. */
.card-thumb {
  width: 72px;
  height: 72px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  flex: none;
}

/* The player's box, and the only place a card reserves a ratio.
   ⚠ 16:9 because an iframe REPLACES this element on the first click — it is the embed's own
   geometry, not a presentation choice, and any other value letterboxes a real video inside its
   own player. The ratio lives on the wrapper so the box exists before the thumbnail's bytes do,
   which is the same byte-independence direct media gets from its width/height attributes. */
/* ⚠⚠ `width: 100%` is scoped to the column, and the scoping is the guard. Unscoped, this rule
   arms the sizing that DELETES the card's text: in a row, a basis of the whole content box beside
   `.card-text`'s basis of 0% leaves the text at 0px wide, hidden behind its own `overflow`. What
   disarmed it was a class binding, so every CSS-side way of losing the column — renaming
   `.card-video`, dropping its `flex-direction`, a later media query, a future non-video card
   wanting this box — kept the suite green while the title vanished. happy-dom applies no
   stylesheet, so no test can ever observe that; expressing the dependency in the selector is what
   makes it unlosable. */
.card-video .card-media {
  width: 100%;
}
.card-media {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: var(--radius-md);
  overflow: hidden;
  /* Reads against the card's own panel, not against the chat background. */
  background: var(--bg);
}
.card-play {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  position: relative;
}
/* ⚠ Drawn INSIDE the box. This button exactly fills `.card-media`, which is `overflow: hidden`,
   so a UA focus ring — painted outside the border box — is clipped away entirely and a keyboard
   user tabbing onto a video card sees nothing move before pressing Enter. */
.card-play:focus-visible {
  outline-offset: -3px;
}
.card-thumb-wide {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.play-badge {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 48px;
  height: 48px;
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg) 70%, transparent);
  /* ⚠ The ring is what makes this a control when there is NO thumbnail. The fill is `--bg` at 70%
     alpha and it sits on `.card-media`, which paints `--bg` — and 70%-alpha X over X is X, so on
     a thumbnail-less video card (the degraded record, and a real state this suite mounts) the
     pill was perfectly invisible and the ▶ floated bare on a flat rectangle. A border reads in
     both cases: an edge here, a light rim against a photo. */
  border: 1px solid color-mix(in srgb, var(--fg) 25%, transparent);
  color: var(--fg);
  display: flex;
  align-items: center;
  justify-content: center;
  /* Optically centred: a triangle glyph's visual mass sits left of its box. */
  padding-left: 3px;
}
.card-embed {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}
</style>
