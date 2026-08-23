// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// "Bind a text input to a ref without v-model, so an IME can't freeze it."
//
// v-model on a native <input>/<textarea> compiles to vModelText, which carries a
// `composing` flag — set between compositionstart and compositionend — and refuses
// to do anything while it is up. Its input listener opens with
// `if (e.target.composing) return`, and its beforeUpdate hook bails the same way
// before it would write. On a desktop CJK IME that covers a candidate session; on
// an Android soft keyboard with suggestions on it covers EVERY WORD, first letter
// to space. Firefox on Android composes the most aggressively of the mobile
// engines, which is where this first surfaced (lurker#624).
//
// Both halves of that guard hurt anything that reads the model as you type:
//   - READ  — a live filter list, or a submit button gated on the model, sits a
//             whole word stale. The tell is "it updates the moment I dismiss the
//             keyboard": that's compositionend delivering the word in one go. A
//             single-word field (a channel name, a token name) has no spaces at
//             all, so the gate can stay wrong for the entire value.
//   - WRITE — a programmatic `model.value = ''` (a clear button, an Esc, a reset
//             after save) does not reach the DOM, leaving text on screen the model
//             no longer holds.
//
// A plain `:value` binding has no such flag: patchDOMProp writes el.value whenever
// the model differs and skips when it doesn't, so normal typing leaves the caret
// alone while a genuine divergence still repaints. Paired with the unconditional
// input handler below, model and DOM track each other in both directions no matter
// what the IME is doing.
//
//   const onQueryInput = useImeSafeInput(query);
//   <input :value="query" @input="onQueryInput" />
//
// Deliberately the read half only. The composer (MessageInput.vue) needs more —
// it re-runs on change/compositionend as backstops and re-establishes the write
// guard in the drafts store, because a missed sync there corrupts a sent message.
// See the "IME composition" note there. Callers of THIS never splice into the
// field mid-composition, so `input` alone is the whole premise.

import type { Ref } from 'vue';

export function useImeSafeInput(model: Ref<string>) {
  return (e: Event) => {
    const el = e.target as HTMLInputElement | HTMLTextAreaElement | null;
    if (el) model.value = el.value;
  };
}
