// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// What `limit` counts on a `history` request.
//
// The server sizes a page in stored rows; we render CONSOLIDATED rows, folding
// each run of join/part/quit/nick/chghost into one summary line. On a channel
// coming back from a netsplit that mismatch is the difference between a full
// screen and three visible lines — we'd fetch, fold, notice the page was short,
// fetch again, and the user would watch the buffer assemble itself.
// `countBy:'renderable'` asks the server to spend the budget only on rows that
// render as their own line; the presence churn still arrives (consolidation
// needs the whole run to summarize it) but no longer eats the page.
//
// Asking for it is only correct WHEN WE ACTUALLY FOLD. With
// `chat.consolidate_joins` off every event renders as its own line, so 'event'
// is already the right unit — and asking for 'renderable' there would pull the
// server's whole scan window (up to 2000 rows) into a page the user then sees
// in full. Hence the gate: the unit we request must match the unit we render.

import { useSettingsStore } from '../stores/settings.js';

export type HistoryCountBy = 'event' | 'renderable';

export function historyCountBy(): HistoryCountBy {
  return useSettingsStore().effective('chat.consolidate_joins') ? 'renderable' : 'event';
}
