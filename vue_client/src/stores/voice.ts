// Copyright (c) 2026 Brad Root
// SPDX-License-Identifier: MPL-2.0

// Voice call session for the web client. The browser IS the WebRTC engine here,
// so this is thin: get a room-scoped token from /api/voice/token, connect the
// LiveKit room, publish the mic, and play remote audio through hidden <audio>
// elements.
//
// Bundle bloat, addressed: livekit-client is ~500 KB and voice is off by default
// on most instances, so it is pulled in with a dynamic import() inside the
// connect path — Vite splits it into its own chunk fetched only at first call.
//
// The Room and all Track/element handles are held module-scoped, NOT in Pinia
// state: they are non-serializable and must not be wrapped in Vue's reactive
// proxy, which would break livekit's object identity. State carries only the
// primitives the UI renders.

import { defineStore } from 'pinia';
import type { Room, RemoteTrack, RemoteAudioTrack, Participant } from 'livekit-client';
import { api } from '../api.js';

interface VoiceTokenResponse {
  token: string;
  room: string;
  url: string;
}

// Non-reactive session handles (see header note).
let room: Room | null = null;
let audioEls: HTMLAudioElement[] = [];
// identity → remote MIC track, for per-participant volume.
let tracksByIdentity = new Map<string, RemoteAudioTrack>();

export const useVoiceStore = defineStore('voice', {
  state: () => ({
    active: false,
    connecting: false,
    muted: false,
    // Human label for what's being called, e.g. "#dev".
    label: '',
    // The channel/DM this call belongs to, so UI can tell "in THIS call" from
    // "in a call somewhere else".
    networkId: null as number | null,
    target: '',
    // Remote participant identities (their IRC nicks).
    participants: [] as string[],
    // Subset of `participants` currently detected as speaking.
    speaking: [] as string[],
    // Per-identity local playback volume, 0..1 (default 1 when absent).
    volumes: {} as Record<string, number>,
    error: null as string | null,
  }),
  actions: {
    /** Mint a token for a channel/DM on a network, then connect the room. */
    async startCall(networkId: number, target: string, label: string) {
      if (this.active || this.connecting) return;
      this.connecting = true;
      this.error = null;
      this.label = label;
      this.networkId = networkId;
      this.target = target;
      try {
        // Token first, so a 503/403/409 fails fast without paying to load the SDK.
        const { token, url } = await api<VoiceTokenResponse>('/api/voice/token', {
          method: 'POST',
          body: { networkId, target },
        });

        // Lazy chunk: livekit-client only lands over the network at first call.
        const { Room, RoomEvent, Track } = await import('livekit-client');

        const r = new Room({ adaptiveStream: true, dynacast: true });
        r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, participant) => {
          if (track.kind !== Track.Kind.Audio) return; // video: PR'd separately
          const audio = track as RemoteAudioTrack;
          // Attach ALL audio so it plays, but only bind the per-participant
          // volume slider to the mic track (a native client may also send
          // screen-share audio, which shares the participant identity).
          const el = audio.attach() as HTMLAudioElement;
          el.autoplay = true;
          document.body.appendChild(el);
          audioEls.push(el);
          if (String(pub.source) === 'microphone') {
            tracksByIdentity.set(participant.identity, audio);
            const stored = this.volumes[participant.identity];
            if (stored != null) audio.setVolume(stored);
          }
        })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub, participant) => {
            if (track.kind !== Track.Kind.Audio) return;
            // Only the mic unsubscribing clears the volume mapping — a
            // participant can also carry screen-share audio, and losing THAT
            // must not orphan their volume slider.
            if (String(pub.source) === 'microphone') tracksByIdentity.delete(participant.identity);
            const detached = track.detach();
            detached.forEach((el) => el.remove());
            audioEls = audioEls.filter((el) => !detached.includes(el));
          })
          .on(RoomEvent.ParticipantConnected, () => this.syncParticipants())
          .on(RoomEvent.ParticipantDisconnected, () => this.syncParticipants())
          .on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => {
            const self = r.localParticipant.identity;
            this.speaking = speakers.map((p) => p.identity).filter((id) => id !== self);
          })
          .on(RoomEvent.Disconnected, () => {
            void this.cleanup();
          });

        await r.connect(url, token);
        // Hold the handle BEFORE enabling the mic: if the user denies mic
        // permission, the catch's cleanup() must still disconnect this
        // already-joined room — otherwise they stay in the call as a ghost
        // participant with no UI to leave.
        room = r;
        await r.localParticipant.setMicrophoneEnabled(true);
        this.active = true;
        this.muted = false;
        this.error = null;
        this.syncParticipants();
      } catch (e: unknown) {
        this.error = e instanceof Error ? e.message : 'could not start call';
        await this.cleanup();
      } finally {
        this.connecting = false;
      }
    },

    syncParticipants() {
      this.participants = room
        ? Array.from(room.remoteParticipants.values()).map((p) => p.identity)
        : [];
    },

    /** Set a remote participant's local playback volume (0..1). Kept in state so
     *  it survives a track re-subscribe within the same session. */
    setVolume(identity: string, volume: number) {
      const v = Math.max(0, Math.min(1, volume));
      this.volumes[identity] = v;
      tracksByIdentity.get(identity)?.setVolume(v);
    },

    async toggleMute() {
      if (!room) return;
      // Flip state only after the SFU confirms. An optimistic flip that then
      // rejects (device error, mid-reconnect) would render the mic-slash icon
      // while the track is still transmitting — the worst kind of wrong.
      const wantMuted = !this.muted;
      try {
        await room.localParticipant.setMicrophoneEnabled(!wantMuted);
        this.muted = wantMuted;
      } catch (e: unknown) {
        this.error = e instanceof Error ? e.message : 'could not toggle mute';
      }
    },

    clearError() {
      this.error = null;
    },

    async leave() {
      await this.cleanup();
    },

    async cleanup() {
      if (room) {
        try {
          await room.disconnect();
        } catch {
          /* already gone */
        }
        room = null;
      }
      audioEls.forEach((el) => el.remove());
      audioEls = [];
      tracksByIdentity = new Map();
      this.active = false;
      this.connecting = false;
      this.muted = false;
      this.participants = [];
      this.speaking = [];
      this.volumes = {};
      this.networkId = null;
      this.target = '';
    },
  },
});
