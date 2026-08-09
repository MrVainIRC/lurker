<!--
  Copyright (c) 2026 Brad Root
  SPDX-License-Identifier: MPL-2.0
-->

<template>
  <div class="attachments">
    <!-- Two or more images become one MOSAIC: a grid whose cells are chosen by the COUNT, each
         image cropped to fill its cell.

         ⚠⚠ This replaced a horizontally-scrolling filmstrip, and the reason is the interaction
         rather than the look. A sideways scroller inside a vertically-scrolling list is a
         gesture conflict on touch — a diagonal drag has to be arbitrated, and the loser is
         whichever one the reader meant — and it hides content behind an affordance (a mask
         fade) that has to be measured, observed and kept in sync. The mosaic shows everything at
         once, needs no scroll container, no ResizeObserver and no fade.

         It keeps the property the strip was built for: the group's height is a function of the
         IMAGE COUNT alone, so a message has one of two possible attachment heights instead of
         one per picture. That is what makes it byte-independent AND descriptor-independent —
         nothing here reads a dimension. Cropping is what buys it, and cropping is recoverable
         because any cell opens the whole set in the viewer. -->
    <div v-if="mosaic.length > 1" class="mosaic" :class="`n${mosaic.length}`">
      <div v-for="(item, i) in mosaic" :key="item.url" class="tile">
        <MessageAttachment
          :preview="item"
          tiled
          @measured="$emit('measured')"
          @activate="openAt(item)"
        />
        <!-- The overflow indicator. It sits on the LAST visible tile rather than adding a cell,
             so the grid stays 2x2 whether a message carries four images or forty. -->
        <template v-if="i === mosaic.length - 1 && overflow > 0">
          <span class="more" aria-hidden="true">+{{ overflow }}</span>
          <span class="sr-only">{{ overflow }} more image{{ overflow === 1 ? '' : 's' }}</span>
        </template>
      </div>
    </div>
    <MessageAttachment
      v-for="item in stacked"
      :key="item.url"
      :preview="item"
      @measured="$emit('measured')"
      @activate="openAt(item)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useMediaViewer } from '../composables/useMediaViewer.js';
import type { LinkPreview } from '../composables/useLinkPreview.js';
import MessageAttachment from './MessageAttachment.vue';

/**
 * The ARRANGEMENT of one message's attachments; MessageAttachment owns how any one of them
 * looks, and MessageBody owns which of them exist.
 *
 * ⚠ Purely presentational — it receives an already-resolved, already-latched, already-permitted
 * list. It used to take the message TEXT and derive all of that itself, and it cannot any more:
 * the body's text needs the same resolved set in order to drop a URL whose image is on screen,
 * and two components deriving one fact is the defect class this feature keeps producing. The
 * derivation moved up to MessageBody; this renders what it is handed.
 */
const props = defineProps<{ previews: LinkPreview[] }>();

defineEmits<{ measured: [] }>();

const viewer = useMediaViewer();

/**
 * How many tiles the mosaic draws before it starts counting instead.
 *
 * Four is two full rows. A fifth would either add a row — and a message's height stops being a
 * small known set — or shrink every cell to fit, which is worse the more images there are.
 * Everything past the fourth is reachable through the viewer, which has always been a gallery.
 */
const MOSAIC_CELLS = 4;

/**
 * Every image in the message, in order.
 *
 * ⚠ IMAGES only, and video is the deliberate omission. MediaViewerModal derives which element to
 * render from the URL's extension, and a proxy path has none — `mediaKindForUrl` returns null for
 * a relative URL — so it falls back to `image` and would mount a video's bytes in an `<img>`,
 * producing the "open in browser" failure card for a file that plays fine inline.
 *
 * ⚠ It is also why a video is never a mosaic tile. A player cropped into a grid cell is not a
 * player: its controls are the part that gets cut. Video and audio stack at full width, where
 * their transport has room, which is what audio has always done.
 */
const images = computed(() => props.previews.filter((p) => p.kind === 'image'));

/** The tiles actually drawn. A lone image is not a one-cell mosaic — see `stacked`. */
const mosaic = computed(() => (images.value.length > 1 ? images.value.slice(0, MOSAIC_CELLS) : []));

/** How many images the mosaic is standing in for. Zero unless the message is genuinely long. */
const overflow = computed(() => Math.max(0, images.value.length - mosaic.value.length));

/**
 * Everything the mosaic didn't take: cards, video, audio — and a lone image, which renders on its
 * own at its own size. That last case is the common one, and a one-cell mosaic would only crop it
 * for no reason.
 */
const stacked = computed(() => {
  const tiled = new Set(mosaic.value);
  return props.previews.filter((p) => !tiled.has(p));
});

/**
 * Open the viewer over EVERY image in the message, positioned on the one that was clicked.
 *
 * ⚠ The gallery is `images`, not `mosaic`, and that is what makes both the cap and the crop
 * safe: the fifth image of a message is not drawn, and the reader still reaches it by arrowing.
 * A lone image is a gallery of one, which the viewer has always handled.
 *
 * ⚠ The viewer gets `src` — OUR proxy path — never the origin URL. Handing it `preview.url` broke
 * the promise the setting makes in so many words ("the file is fetched and served by your Lurker
 * server, so the site hosting it never sees your device"): the image rendered inline through the
 * proxy, and then clicking it went straight to the remote host. It also meant an `http://` image
 * displayed fine inline but was blocked as mixed content once the lightbox loaded it directly.
 * `shareUrl` carries the ORIGIN address alongside, so "copy link" hands over something another
 * person can actually open.
 */
function openAt(item: LinkPreview): void {
  const gallery = images.value;
  const at = gallery.indexOf(item);
  if (at === -1) return;
  viewer.openGallery(
    gallery.map((p) => ({ url: p.src ?? p.url, shareUrl: p.url })),
    at,
  );
}
</script>

<style scoped>
.attachments {
  display: flex;
  flex-direction: column;
  /* NOT the default `stretch`. A flex column stretches its children across the cross axis,
     which forced every inline image to the container's full width while `max-height` capped
     its height — squashing it instead of scaling it. */
  align-items: flex-start;
  gap: var(--space-2);
  /* Breathing room on BOTH sides. The bottom margin matters more than it looks: without it an
     image or card sits flush against the next author's name, and the attachment reads as
     belonging to the message below it rather than the one above. */
  margin-top: var(--space-2);
  margin-bottom: var(--space-4);
  max-width: 100%;
  min-width: 0;
}
/* A card wants the width it's given — its text has to wrap against something — but not the
   full width of a wide window, where it stops reading as part of the message and starts
   reading as a page element.
   ⚠ 400 rather than 480, and the CARD is what was narrowed rather than the picture inside it.
   A hero capped below its card's width leaves a band of empty panel down one side, which reads
   as a layout mistake rather than as a smaller image; narrowing the card keeps the picture
   flush to both edges and takes the height down with it (376px of content box at 1200/630 is
   ~197px tall, against ~239px at 480). The square card gets narrower too, which costs its text
   80px of wrapping width it did not need. */
.attachments > :deep(.card) {
  align-self: stretch;
  max-width: 400px;
}

/* ─── The mosaic ──────────────────────────────────────────────────────────────
   Cells from the count, height from the cells. Nothing reads an image's dimensions, so the
   whole grid is laid out correctly before a single byte of any picture arrives — the same
   byte-independence a lone image gets from its reserved box, reached without needing one.

   ⚠ One row height, and every layout is a whole number of rows: 1 row for two images, 2 rows
   for three or more. So a mosaic is 160px or 324px tall (2 × 160 plus the 4px gap) and never
   anything else, which is the property the filmstrip's fixed height existed to provide. */
.mosaic {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-auto-rows: 160px;
  gap: var(--space-2);
  width: 100%;
  /* Matches the card's cap. Past this the mosaic stops reading as part of a message and starts
     reading as a page element — and on a wide window a 2-up grid of full-width cells is a
     slideshow, not an annotation. */
  max-width: 480px;
}
/* Three images: a full-height picture beside two stacked ones. Discord's arrangement, and it is
   the one that gives an odd count a shape rather than a gap — a 2x2 grid with three items leaves
   a hole, and stretching the third across the bottom makes it the subject of the message. */
.mosaic.n3 > .tile:first-child {
  grid-row: span 2;
}

/* The grid item. The image inside is a `display: contents` wrapper's child (see
   MessageAttachment), so it becomes this element's own child for layout — which is why the
   clipping, the rounding and the overlay all live here rather than on the picture. */
.tile {
  position: relative;
  overflow: hidden;
  border-radius: var(--radius-md);
  /* A grid item's automatic minimum is its content, so a wide image would otherwise refuse to
     shrink and push the second column off the row. */
  min-width: 0;
}

/* The overflow count, drawn over the last tile.
   ⚠ `inset: 0` rather than a corner badge: the whole cell is the target, and the cell is already
   a button (the image carries the role). A small badge would read as a separate control sitting
   on top of one, with no way to tell which a tap would hit. */
.more {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--bg) 60%, transparent);
  color: var(--fg);
  font-weight: 600;
  /* The image beneath owns the click; this is a label, not a control. */
  pointer-events: none;
}

/* The count again, for a screen reader, because `+6` is not a sentence. Clipped rather than
   `display: none`, which would take it out of the accessibility tree along with the layout. */
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}
</style>
