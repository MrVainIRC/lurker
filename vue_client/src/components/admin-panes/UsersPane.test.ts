// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { useAdminStore } from '../../stores/admin.js';
import UsersPane from './UsersPane.vue';

describe('UsersPane user settings', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('places settings beside pause/delete and opens controls for regular users', async () => {
    const admin = useAdminStore();
    admin.users = [
      {
        id: 7,
        username: 'member',
        role: 'user',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 8,
        username: 'operator',
        role: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    admin.settingsVisibility = [{ id: 7, username: 'member', hiddenKeys: ['look.font.family'] }];
    admin.settingKeys = ['look.font.family', 'chat.events'];
    admin.settingsVisibilityLoaded = true;
    vi.spyOn(admin, 'fetchUsers').mockResolvedValue();
    vi.spyOn(admin, 'fetchSettingsVisibility').mockResolvedValue();
    const setVisibility = vi.spyOn(admin, 'setSettingsVisibility').mockResolvedValue();

    const wrapper = mount(UsersPane);
    const rows = wrapper.findAll('li.user-row');
    expect(rows[0]!.find('.row-actions').text()).toContain('settings');
    expect(rows[0]!.find('.row-actions').text()).toContain('delete');
    expect(rows[1]!.find('.row-actions').text()).not.toContain('settings');

    await rows[0]!.find('button').trigger('click');
    expect(rows[0]!.text()).toContain('user settings');
    expect((rows[0]!.find('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(
      false,
    );

    await rows[0]!.find('input[type="checkbox"]').trigger('change');
    expect(setVisibility).toHaveBeenCalledWith(7, []);
  });
});
