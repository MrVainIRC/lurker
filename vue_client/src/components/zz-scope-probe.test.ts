// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { computed, ref, type Ref } from 'vue';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import MessageBody from '/Users/amiantos/Coding/lurker-dev/lurker/vue_client/src/components/MessageBody.vue';
import { useSettingsStore } from '/Users/amiantos/Coding/lurker-dev/lurker/vue_client/src/stores/settings.js';
import { useConfigStore } from '/Users/amiantos/Coding/lurker-dev/lurker/vue_client/src/stores/config.js';

const P = {
  url: 'https://e.test/1.png',
  status: 'ok',
  kind: 'image',
  src: '/api/lp/m/1',
  thumbWidth: 800,
  thumbHeight: 600,
  expiresAt: '2099-01-01T00:00:00Z',
};
vi.mock(
  '/Users/amiantos/Coding/lurker-dev/lurker/vue_client/src/composables/useLinkPreview.js',
  () => ({
    useLinkPreview: () => ref(P),
    usePreviewsSettled: (_u: Ref<readonly string[]>) => computed(() => true),
  }),
);

describe('scope id propagation through a fragment root', () => {
  it('reports which data-v-* attributes land on .attachments', () => {
    setActivePinia(createPinia());
    useConfigStore().features = { linkPreviews: true };
    const s = useSettingsStore();
    s.values = { 'chat.inline_media.enabled': true, 'chat.link_previews.enabled': true };
    s.loaded = true;
    const w = mount(MessageBody, { props: { text: P.url, segments: [] } });
    const el = w.find('.attachments').element as HTMLElement;
    const attrs = [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-v-'));
    console.log('MessageBody is a fragment (multi-root):', w.vm.$.subTree.shapeFlag);
    console.log('.attachments scope attrs:', JSON.stringify(attrs));
    console.log('.attachments outerHTML head:', el.outerHTML.slice(0, 160));
    expect(true).toBe(true);
  });
});
