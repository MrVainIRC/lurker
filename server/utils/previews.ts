// Copyright (c) 2026 Brad Root

// SPDX-License-Identifier: MPL-2.0

/**
 * Whether link previews and inline media exist on this instance at all.
 *
 * ⚠ The presence of `LURKER_PREVIEWS_URL` IS the feature flag, and that is the whole gate —
 * there is no separate on/off switch. It reads oddly until you see why: previews are resolved
 * by the `lurker-previews` decoder (a second container), and pointing at one is the only way
 * the feature can function at all. So "is a decoder configured" and "is the feature on" are the
 * same question, and a single knob cannot express the one broken state a second one could — a
 * feature switched on with nowhere to resolve, every preview failing forever.
 *
 * This preserves the property the old `LURKER_LINK_PREVIEWS` flag existed for: previews are the
 * one feature that makes the instance dial arbitrary user-supplied URLs, so turning them on must
 * be a deliberate operator act rather than something an upgrade inherits. Standing up a decoder
 * and naming it here is exactly that act — you cannot arrive at it by accident, which is the
 * same bar the explicit flag set, reached with one fewer thing to keep in sync. Off by default
 * because an unset URL is off.
 *
 * The two per-user settings remain independent and also default off: this decides whether the
 * instance participates, those decide whether *you* see previews. When this is off the routes
 * aren't mounted, the resolver never runs, and both clients hide those two settings rather than
 * offering toggles that do nothing.
 *
 * ⚠ Lives in `utils/` beside `edition.ts` rather than in the resolver it gates. `app.ts` and
 * `routes/config.ts` both need the answer, and neither should have to pull the resolver — with
 * its sqlite and http agents — into its module graph to read one environment variable.
 */
export function previewsEnabled(): boolean {
  return !!process.env.LURKER_PREVIEWS_URL?.trim();
}
