// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

import db from './index.js';

export function listHiddenSettingKeys(userId: number): string[] {
  return (
    db
      .prepare(
        'SELECT setting_key FROM user_setting_visibility WHERE user_id = ? ORDER BY setting_key',
      )
      .all(userId) as Array<{ setting_key: string }>
  ).map((row) => row.setting_key);
}

export function replaceHiddenSettingKeys(userId: number, keys: string[]): void {
  const replace = db.transaction((settingKeys: string[]) => {
    db.prepare('DELETE FROM user_setting_visibility WHERE user_id = ?').run(userId);
    const insert = db.prepare(
      'INSERT INTO user_setting_visibility (user_id, setting_key) VALUES (?, ?)',
    );
    for (const key of settingKeys) insert.run(userId, key);
  });
  replace(keys);
}
