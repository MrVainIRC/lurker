// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { createUrlRegex } from '../../../shared/urlPattern.js';
import { mediaKindForUrl } from './uploadHostMatch.js';
import {
  isBracketedUrl,
  parseIrcFormatting,
  trimTrailingPunctuation,
  type RenderSegment,
} from './nickColor.js';

/**
 * Cap on CARDS per message.
 *
 * Slack allows five, halloy defaults to one. Three is enough for a message genuinely sharing
 * a few links, and short of enough for one message to take over a screen. Each card costs
 * real vertical space, so this one has to stay tight.
 */
export const MAX_CARDS_PER_MESSAGE = 3;

/**
 * Cap on MEDIA per message — deliberately generous.
 *
 * Media doesn't cost vertical space the way a card does: two or more images render as a mosaic
 * of fixed-size cells, two per row, so a tenth image costs half a row rather than a full-width
 * picture's worth of screen. And clicking any cell opens the lightbox as a GALLERY over every
 * image in the message.
 *
 * ⚠ This is now the ONLY bound on how tall one message's media can get. The mosaic used to cap
 * itself at four cells and count the rest (`+N`), and lurker#773 dropped that to match
 * lurker-ios; at this limit the worst case is ten rows of grid, which is a long message and not a
 * runaway one. Lowering the number is the lever if that ever stops being true.
 *
 * A limit still exists, because a message carrying fifty image URLs is spam and each one is
 * an outbound fetch on the server's behalf. It's set high enough not to bind on anything a
 * person would actually post.
 */
export const MAX_MEDIA_PER_MESSAGE = 20;

export interface PreviewToggles {
  inlineMedia: boolean;
  linkPreviews: boolean;
}

/**
 * Which URLs in a message body are worth asking the server about.
 *
 * The two toggles select different URLs, which is the whole reason they're two
 * settings: inline media covers links that ARE a file, link previews cover links
 * to a page. With both off this returns an empty array without touching the
 * network — that's what makes the features genuinely free when disabled.
 *
 * ⚠ The extension test here is a HINT, not a verdict. It decides which setting
 * would cover a URL and therefore whether to bother asking; the server answers
 * authoritatively from Content-Type, and the render path re-checks that answer
 * against the settings. Guessing wrong costs one wasted resolve, never a render
 * the user switched off.
 *
 * ⚠⚠ Runs through the IRC formatting parser rather than over the raw wire text, for two
 * reasons that both bite. A URL inside a SPOILER run must not be resolved at all — the
 * renderer (nickColor's `toRenderSegments`) deliberately skips URL splitting there so a link
 * can't leak hidden content, and unfurling one renders the target full-size next to the
 * click-to-reveal box, which defeats the spoiler completely. And formatting codes live INSIDE
 * the matched token otherwise: `\x03` on the end of a URL was being sent to the resolver as
 * part of the address.
 */
export function previewableUrls(
  text: string | null | undefined,
  { inlineMedia, linkPreviews }: PreviewToggles,
): string[] {
  if (!inlineMedia && !linkPreviews) return [];
  if (!text) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  let mediaCount = 0;
  let cardCount = 0;

  for (const run of parseIrcFormatting(text)) {
    // Same test the renderer uses for the IRC spoiler convention: a run whose foreground and
    // background are the same *renderable* colour is invisible text.
    //
    // ⚠ The `<= 15` half has to match splitTextByTokens exactly. Slots above 15 paint nothing,
    // so such a run isn't hidden and its links are ordinary links — and since applySpoilerMarkup
    // now closes a spoiler with `\x0399,99` when a digit follows, the tail of those messages is
    // a 99,99 run. Without this, a URL anywhere after such a spoiler would silently lose its
    // preview, which is a hard failure to trace back to a colour code.
    if (run.fg != null && run.bg != null && run.fg === run.bg && run.fg <= 15) continue;

    for (const match of run.text.matchAll(createUrlRegex())) {
      const raw = match[0];
      // The shared pattern also matches bare `www.` hosts and email addresses.
      // Neither is fetchable as written, and we are emphatically not resolving
      // somebody's email address.
      if (!/^https?:\/\//i.test(raw)) continue;

      // ⚠ `<https://example.com>` is an explicit "link, but don't unfurl it" — the one way a
      // poster can suppress a preview per-link, and the reason there is no other control for
      // it. Skipped BEFORE `seen`, so a URL posted bare earlier in the same message still
      // resolves: the brackets speak for the occurrence they wrap, not for the address.
      if (isBracketedUrl(run.text, match.index, raw)) continue;

      // ⚠ The LINKIFIER's trimmer, deliberately shared rather than re-expressed. The old
      // regex stripped closing brackets unconditionally while the anchor-building path is
      // balance-aware, so `…/wiki/Rust_(programming_language)` was resolved a character short
      // of the URL the user actually clicks: the card silently never appeared, and the 404 was
      // cached for an hour under a string appearing nowhere in the message. Two parsers
      // disagreeing about where a URL ends is the bug; one parser is the fix.
      const url = trimTrailingPunctuation(raw);
      if (!url || seen.has(url)) continue;

      // Three-way, not two. `mediaKindForUrl` returns null both for "definitely a page" and
      // for "no extension to judge by" — and collapsing those meant an extensionless image
      // host (imgur, twimg) could never render for someone who enabled ONLY inline media,
      // permanently, since priming is ingest-driven. Unknowns are charged to the CARD budget,
      // which is the tight one, so honouring them can't turn a link-heavy message into twenty
      // speculative fetches.
      const isMedia = mediaKindForUrl(url) !== null;
      const wanted = isMedia ? inlineMedia : linkPreviews || inlineMedia;
      if (!wanted) continue;
      if (isMedia ? mediaCount >= MAX_MEDIA_PER_MESSAGE : cardCount >= MAX_CARDS_PER_MESSAGE)
        continue;

      if (isMedia) mediaCount++;
      else cardCount++;
      seen.add(url);
      out.push(url);
    }
  }
  return out;
}

interface UrlSpan {
  url: string;
  /** Offsets into the VISIBLE body — formatting codes removed, spoiler text kept. */
  start: number;
  end: number;
}

/**
 * Every resolvable URL in `text`, with where it sits in what the reader actually sees.
 *
 * ⚠⚠ Spoiler runs contribute their TEXT but none of their URLs, and both halves matter.
 * `previewableUrls` skips those runs entirely because a hidden link must not be resolved; here
 * the run's characters still occupy the line, so a URL following a spoiler is not at the start
 * of the message and must not be treated as though it were.
 */
function urlSpans(text: string): { visible: string; spans: UrlSpan[] } {
  let visible = '';
  const spans: UrlSpan[] = [];
  for (const run of parseIrcFormatting(text)) {
    const base = visible.length;
    visible += run.text;
    if (run.fg != null && run.bg != null && run.fg === run.bg && run.fg <= 15) continue;
    for (const match of run.text.matchAll(createUrlRegex())) {
      const raw = match[0];
      if (!/^https?:\/\//i.test(raw)) continue;
      if (isBracketedUrl(run.text, match.index, raw)) continue;
      const url = trimTrailingPunctuation(raw);
      if (!url) continue;
      spans.push({ url, start: base + match.index, end: base + match.index + url.length });
    }
  }
  return { visible, spans };
}

/**
 * Which of `candidates` may have their URL text removed from the message body.
 *
 * The rule: a URL is hideable when nothing but whitespace and OTHER HIDEABLE URLs sit between it
 * and the start or the end of the message. So a message that is nothing but links loses all of
 * them, a message that opens or closes with one loses that one, and a URL with prose on both
 * sides keeps its text — because there the address is part of a sentence somebody wrote.
 *
 * ⚠⚠ Implemented as a peel from each end rather than as a per-URL edge test, and the difference
 * is case (a). In `https://a.png https://b.png https://c.png` the middle URL touches neither
 * edge; testing it alone leaves one bare address stranded between two images. Peeling consumes
 * `a` first, which is what makes `b` an edge.
 *
 * ⚠ The peel STOPS at a non-candidate rather than stepping over it. A page link renders as a
 * card and keeps its URL, so anything behind it is no longer against the edge — hiding it would
 * leave the image's address gone while the card's remained, in the middle of the line.
 *
 * ⚠ Hiding is by URL STRING, so the same address posted twice loses both occurrences when either
 * is at an edge. Left as-is: it is one address, it renders one preview, and a message repeating a
 * link is not a case worth carrying span identity through the renderer for.
 */
export function hideableUrls(
  text: string | null | undefined,
  candidates: ReadonlySet<string>,
): Set<string> {
  const out = new Set<string>();
  if (!text || candidates.size === 0) return out;
  const { visible, spans } = urlSpans(text);

  let cursor = 0;
  for (const span of spans) {
    if (!candidates.has(span.url)) break;
    if (visible.slice(cursor, span.start).trim() !== '') break;
    out.add(span.url);
    cursor = span.end;
  }

  cursor = visible.length;
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (!candidates.has(span.url)) break;
    if (visible.slice(span.end, cursor).trim() !== '') break;
    out.add(span.url);
    cursor = span.start;
  }

  return out;
}

/**
 * Whitespace in this segment is dead space rather than ink, so trimming it changes nothing a
 * reader can see.
 *
 * ⚠⚠ Three attributes make whitespace VISIBLE, not one. A mIRC background run paints its spaces,
 * so a colour block beside a hidden link is a drawing and collapsing it deletes part of the
 * message — that was the case this guard was written for. `underline` and `strike` do the same
 * thing with a rule instead of a fill: `look \x1f   \x1f https://x.png` draws a short line, and
 * trimming it takes the line away. Same class, and the first version was two conditions short of
 * the rule its own comment stated.
 */
function isTrimmableText(seg: RenderSegment): boolean {
  return (
    !seg.url && !seg.channel && !seg.spoiler && seg.bg == null && !seg.underline && !seg.strike
  );
}

/**
 * The message body with `hidden`'s URL segments taken out, and the gap they leave closed up.
 *
 * Returns the ORIGINAL array when nothing is dropped, so the overwhelmingly common case costs one
 * `Set.size` check and no allocation — this runs per message row.
 *
 * ⚠ The trim is what makes the result read as a sentence rather than as one with a hole in it.
 * Dropping the URL from `look at this: https://x.png` leaves a trailing space and a colon
 * dangling; dropping it from a message that was ONLY a link leaves a segment list of pure
 * whitespace, which still paints a blank line above the image.
 */
export function segmentsWithoutUrls(
  segments: RenderSegment[],
  hidden: ReadonlySet<string>,
): RenderSegment[] {
  if (!hidden.size) return segments;
  const kept = segments.filter((seg) => !(seg.url && hidden.has(seg.url)));
  if (kept.length === segments.length) return segments;

  let lo = 0;
  let hi = kept.length;
  while (lo < hi && isTrimmableText(kept[lo]) && kept[lo].text.trim() === '') lo++;
  while (hi > lo && isTrimmableText(kept[hi - 1]) && kept[hi - 1].text.trim() === '') hi--;

  const out = kept.slice(lo, hi);
  if (!out.length) return out;
  // ⚠ Copied, never mutated in place. `filter` and `slice` both preserve object identity, so an
  // in-place trim would reach back into the caller's array — which is a Vue PROP.
  //
  // ⚠ The damage is latent rather than visible, and that is the reason to state it: MessageList
  // calls `textSegments(m)` in the template, so it hands over a freshly built array on every
  // render and nothing today survives long enough to be corrupted twice. Memoising that split is
  // an obvious optimisation for a component mounted per row — and the moment someone does, an
  // in-place trim writes the shortened text back into the cache, so the body stays mangled after
  // the preview is gone. (An earlier version of this comment claimed the split was ALREADY
  // memoised. It is not: `useNickColors.splitText` calls straight through.)
  if (isTrimmableText(out[0])) out[0] = { ...out[0], text: out[0].text.replace(/^\s+/, '') };
  const last = out.length - 1;
  if (isTrimmableText(out[last]))
    out[last] = { ...out[last], text: out[last].text.replace(/\s+$/, '') };
  return out;
}
