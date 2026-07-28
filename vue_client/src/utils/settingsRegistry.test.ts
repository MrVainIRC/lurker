// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  REGISTRY,
  categoryVisible,
  optionVisible,
  optionEnabled,
  dependencyHint,
} from './settingsRegistry.js';
import type { SettingOption, SettingValue } from '../../../shared/settingsRegistry.js';

const cat = (id: string) => CATEGORIES.find((c) => c.id === id)!;
const opt = (key: string) => REGISTRY.find((o) => o.key === key)!;

/** An effective-value reader over an override map, defaulting to the registry. */
function reader(overrides: Record<string, SettingValue>) {
  return (key: string): SettingValue | undefined =>
    key in overrides ? overrides[key] : REGISTRY.find((o) => o.key === key)?.default;
}

describe('categoryVisible', () => {
  const standalone = { isNode: false };
  const node = { isNode: true };

  // Instance administration now lives entirely in the /admin panel, so Settings
  // holds nothing an admin sees and a regular user doesn't — the whole adminOnly
  // dimension (and the "users" category that was its only user) is gone.
  it('no longer carries an admin-only category', () => {
    expect(CATEGORIES.some((c) => c.id === 'users')).toBe(false);
  });

  // The behavioural half of the above: role is no longer an input at all, so on a
  // standalone box every category is visible to everyone. Asserted through the
  // function (not just the data) so re-introducing a role gate inside
  // categoryVisible would fail here rather than pass quietly.
  it('shows every non-node-restricted category regardless of role', () => {
    const hidden = CATEGORIES.filter(
      (c) => !c.selfHostedOnly && !categoryVisible(c, standalone),
    ).map((c) => c.id);
    expect(hidden).toStrictEqual([]);
  });

  it('hides selfHostedOnly categories in node edition only', () => {
    expect(categoryVisible(cat('api-tokens'), standalone)).toBe(true);
    expect(categoryVisible(cat('api-tokens'), node)).toBe(false);
  });

  it('shows ordinary categories in both editions', () => {
    expect(categoryVisible(cat('appearance'), standalone)).toBe(true);
    expect(categoryVisible(cat('appearance'), node)).toBe(true);
  });
});

describe('optionVisible', () => {
  it('hides selfHostedOnly settings in node edition, shows them standalone', () => {
    expect(optionVisible(opt('uploads.image.max_upload_mb'), { isNode: false })).toBe(true);
    expect(optionVisible(opt('uploads.image.max_upload_mb'), { isNode: true })).toBe(false);
    expect(optionVisible(opt('uploads.image.quality'), { isNode: true })).toBe(false);
  });

  it('hides the cost/abuse pipeline knobs in node edition (operator-controlled)', () => {
    // dimension / quality / max size are enforced server-side in node edition
    // (A8); the tenant must not be able to set them, here or via the API.
    expect(optionVisible(opt('uploads.image.max_dimension'), { isNode: true })).toBe(false);
    expect(optionVisible(opt('uploads.image.quality'), { isNode: true })).toBe(false);
    expect(optionVisible(opt('uploads.image.max_upload_mb'), { isNode: true })).toBe(false);
    // ...but they stay visible on a self-hosted box.
    expect(optionVisible(opt('uploads.image.quality'), { isNode: false })).toBe(true);
  });

  it('keeps paste-to-upload (a client UX pref, not a cost knob) visible in node edition', () => {
    expect(optionVisible(opt('uploads.paste.enabled'), { isNode: true })).toBe(true);
  });
});

describe('optionEnabled (#666)', () => {
  it('leaves settings without dependencies alone', () => {
    expect(optionEnabled(opt('chat.events'), reader({}))).toBe(true);
  });

  it('ORs its clauses — one device class still using events keeps modifiers live', () => {
    // Why the clauses are ORed rather than ANDed: a phone set to `none` must not
    // grey out the consolidation knobs a desktop is actively using.
    const phoneOnly = reader({ 'chat.events': 'all', 'chat.events.mobile': 'none' });
    expect(optionEnabled(opt('chat.consolidate_joins'), phoneOnly)).toBe(true);

    const bothOff = reader({ 'chat.events': 'none', 'chat.events.mobile': 'none' });
    expect(optionEnabled(opt('chat.consolidate_joins'), bothOff)).toBe(false);
  });

  it('resolves transitively through a chain', () => {
    // consolidate_max_names names only consolidate_joins; the tier condition has
    // to arrive through it, or the registry would restate the whole chain on
    // every leaf.
    const bothOff = reader({ 'chat.events': 'none', 'chat.events.mobile': 'none' });
    expect(optionEnabled(opt('chat.consolidate_max_names'), bothOff)).toBe(false);

    // Its own direct dependency failing is enough on its own.
    const consolidationOff = reader({ 'chat.consolidate_joins': false });
    expect(optionEnabled(opt('chat.consolidate_max_names'), consolidationOff)).toBe(false);

    expect(optionEnabled(opt('chat.consolidate_max_names'), reader({}))).toBe(true);
  });

  it('gates the smart-filter tuning on some device being on the smart tier', () => {
    // Default is `all` on both keys, so the tuning starts inactive — it was
    // reachable-but-inert before the tier, which is the confusion #666 names.
    expect(optionEnabled(opt('chat.smart_filter_delay'), reader({}))).toBe(false);

    const mobileSmart = reader({ 'chat.events.mobile': 'smart' });
    for (const key of [
      'chat.smart_filter_delay',
      'chat.smart_filter_join',
      'chat.smart_filter_quit',
      'chat.smart_filter_nick',
      'chat.smart_filter_join_unmask',
    ]) {
      expect(optionEnabled(opt(key), mobileSmart)).toBe(true);
    }
  });

  it('keeps the event-display modifiers tied to the tier, not to consolidation', () => {
    // show_event_host decorates the INDIVIDUAL lines, which is exactly what
    // survives when consolidation is off — so turning consolidation off must
    // not grey it out.
    const consolidationOff = reader({ 'chat.consolidate_joins': false });
    expect(optionEnabled(opt('chat.show_event_host'), consolidationOff)).toBe(true);
    expect(optionEnabled(opt('chat.show_join_account'), consolidationOff)).toBe(true);

    const bothOff = reader({ 'chat.events': 'none', 'chat.events.mobile': 'none' });
    expect(optionEnabled(opt('chat.show_event_host'), bothOff)).toBe(false);
  });

  it('points every dependency clause at a real registry key', () => {
    // A typo here fails OPEN — the clause can't be resolved further and passes —
    // so nothing would visibly break, which is exactly why it needs asserting.
    const keys = new Set(REGISTRY.map((o) => o.key));
    for (const option of REGISTRY) {
      for (const dep of option.dependsOn ?? []) {
        expect(keys, `${option.key} depends on unknown ${dep.key}`).toContain(dep.key);
      }
    }
  });

  it('bottoms out rather than recursing forever on a cycle', () => {
    const cyclic = {
      ...opt('chat.consolidate_joins'),
      key: 'x.a',
      dependsOn: [{ key: 'x.a', in: [true] }],
    } as SettingOption;
    // getOption('x.a') finds nothing (it isn't in the registry), so the clause
    // resolves on its value check alone — the depth cap is the backstop for a
    // cycle made of keys that ARE registered.
    expect(optionEnabled(cyclic, () => true)).toBe(true);
  });
});

describe('dependencyHint', () => {
  it('names the keys and values that would wake the setting up', () => {
    expect(dependencyHint(opt('chat.smart_filter_delay'))).toBe(
      'Inactive — needs chat.events = smart, or chat.events.mobile = smart.',
    );
  });

  it('renders booleans as on/off rather than true/false', () => {
    expect(dependencyHint(opt('chat.consolidate_max_names'))).toBe(
      'Inactive — needs chat.consolidate_joins = on.',
    );
  });

  it('is empty for a setting with no dependencies', () => {
    expect(dependencyHint(opt('chat.events'))).toBe('');
  });
});
