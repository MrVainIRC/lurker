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
import type {
  Room,
  RemoteTrack,
  RemoteAudioTrack,
  RemoteVideoTrack,
  LocalVideoTrack,
  LocalTrackPublication,
  Participant,
} from 'livekit-client';
import { api } from '../api.js';

interface VoiceTokenResponse {
  token: string;
  room: string;
  url: string;
}

/** The video sources a tile can carry — a closed set, so a typo'd source is a
 *  compile error instead of a tile that silently mis-renders at runtime. */
export type VideoSource = 'camera' | 'screen_share';

/** One video/screen tile the CallBar renders (self + remote). */
export interface VideoTileSpec {
  identity: string;
  source: VideoSource;
  self: boolean;
}

/** Narrow LiveKit's open-ended Track.Source to our tile set at the event
 *  boundary. Anything that isn't a screen share (including 'unknown' video
 *  from an exotic client) renders as a camera tile — fill-fit, mirrored only
 *  for self. */
function videoSourceOf(pubSource: unknown): VideoSource {
  return String(pubSource) === 'screen_share' ? 'screen_share' : 'camera';
}

// Non-reactive session handles (see header note).
let room: Room | null = null;
// `${identity}|${source}` → remote video track; attached by VideoTile, which
// owns the element lifecycle — the room runs adaptiveStream, so a remote video
// track only flows once attach()ed to a VISIBLE <video>.
let videoTracksByKey = new Map<string, RemoteVideoTrack>();
// source → our own local video track, for self tiles.
let localVideoTracks = new Map<VideoSource, LocalVideoTrack>();
// True while OUR OWN toggleMute() is awaiting the SFU — the TrackMuted event
// fires before the await resolves, and without this flag a self-mute is
// indistinguishable from an op's server-mute.
let selfMuteInFlight = false;

const OP_MUTED_MSG = 'a channel operator muted your microphone';
let audioEls: HTMLAudioElement[] = [];
// identity → remote MIC track, for per-participant volume.
let tracksByIdentity = new Map<string, RemoteAudioTrack>();

export const useVoiceStore = defineStore('voice', {
  state: () => ({
    active: false,
    connecting: false,
    muted: false,
    cameraOn: false,
    screenOn: false,
    // Video/screen tiles to render (self + remote) — driven by track events,
    // so device failures and permission revocations can't desync the flags.
    videoTiles: [] as VideoTileSpec[],
    // Human label for what's being called, e.g. "#dev".
    label: '',
    // The channel/DM this call belongs to, so UI can tell "in THIS call" from
    // "in a call somewhere else".
    networkId: null as number | null,
    target: '',
    // True when this tab joined via a public guest link (no account/session) —
    // gates off member-only affordances like moderation.
    isGuest: false,
    // False for a listen-only token (guest links below the talk threshold):
    // the mic is never requested, and the mute toggle must not render — an
    // unmute attempt would prompt for mic permission and then be rejected by
    // the SFU anyway.
    canPublish: true,
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
      // Label BEFORE the token fetch: the CallBar renders it while connecting,
      // and a mint failure (403 policy) must blame the channel it belongs to,
      // not whatever call came before.
      this.label = label;
      this.networkId = networkId;
      this.target = target;
      try {
        // Token first, so a 503/403/409 fails fast without paying to load the SDK.
        const { token, url } = await api<VoiceTokenResponse>('/api/voice/token', {
          method: 'POST',
          body: { networkId, target },
        });
        await this.connectWithToken(url, token, label);
      } catch (e: unknown) {
        await this.cleanup();
        this.error = e instanceof Error ? e.message : 'could not start call';
      } finally {
        this.connecting = false;
      }
    },

    /** Shared connect path — member calls above, and the public guest page
     *  (which has already exchanged its link token for a room token).
     *  `canPublish: false` = a listen-only guest: the mic is never requested
     *  (the SFU would reject the publish outright) and the state pins muted. */
    async connectWithToken(
      url: string,
      token: string,
      label: string,
      opts?: { guest?: boolean; canPublish?: boolean },
    ) {
      if (this.active) return;
      this.connecting = true;
      this.error = null; // a retry must not show the previous attempt's failure
      this.label = label;
      if (opts?.guest) this.isGuest = true;
      const listenOnly = opts?.canPublish === false;
      this.canPublish = !listenOnly;
      try {
        // Lazy chunk: livekit-client only lands over the network at first call.
        const { Room, RoomEvent, Track } = await import('livekit-client');

        const r = new Room({ adaptiveStream: true, dynacast: true });
        r.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub, participant) => {
          if (track.kind === Track.Kind.Audio) {
            const audio = track as RemoteAudioTrack;
            // Attach ALL audio so it plays, but only bind the per-participant
            // volume slider to the mic track (screen-share audio shares the
            // participant identity).
            const el = audio.attach() as HTMLAudioElement;
            el.autoplay = true;
            document.body.appendChild(el);
            audioEls.push(el);
            if (String(pub.source) === 'microphone') {
              tracksByIdentity.set(participant.identity, audio);
              const stored = this.volumes[participant.identity];
              if (stored != null) audio.setVolume(stored);
            }
          } else if (track.kind === Track.Kind.Video) {
            // NOT attached here: the room runs adaptiveStream, so video only
            // flows into a visible element — VideoTile owns attach/detach.
            const source = videoSourceOf(pub.source);
            videoTracksByKey.set(`${participant.identity}|${source}`, track as RemoteVideoTrack);
            this.addTile(participant.identity, source, false);
          }
        })
          .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub, participant) => {
            if (track.kind === Track.Kind.Audio) {
              // Only the mic unsubscribing clears the volume mapping — a
              // participant can also carry screen-share audio, and losing THAT
              // must not orphan their volume slider.
              if (String(pub.source) === 'microphone') {
                tracksByIdentity.delete(participant.identity);
              }
              const detached = track.detach();
              detached.forEach((el) => el.remove());
              audioEls = audioEls.filter((el) => !detached.includes(el));
            } else if (track.kind === Track.Kind.Video) {
              const source = videoSourceOf(pub.source);
              videoTracksByKey.delete(`${participant.identity}|${source}`);
              this.removeTile(participant.identity, source);
              // Detach stops the stream flowing — but do NOT .remove() the
              // elements: unlike the store-created audio tags above, <video>
              // nodes belong to VideoTile's template, and yanking Vue-owned
              // DOM out from under the renderer corrupts its patching.
              track.detach();
            }
          })
          .on(RoomEvent.LocalTrackPublished, (pub: LocalTrackPublication) => {
            if (pub.track?.kind !== Track.Kind.Video) return;
            const source = videoSourceOf(pub.source);
            localVideoTracks.set(source, pub.track as LocalVideoTrack);
            if (source === 'screen_share') this.screenOn = true;
            else this.cameraOn = true;
            this.addTile(r.localParticipant.identity, source, true);
          })
          .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
            // Fires for EVERY unpublish path — our toggle, the browser's
            // "stop sharing" chrome, a device unplugged — so flags and tiles
            // can never desync from reality.
            if (pub.track?.kind !== Track.Kind.Video) return;
            const source = videoSourceOf(pub.source);
            localVideoTracks.delete(source);
            if (source === 'screen_share') this.screenOn = false;
            else this.cameraOn = false;
            this.removeTile(r.localParticipant.identity, source);
          })
          .on(RoomEvent.TrackMuted, (pub, participant) => {
            // Keep `muted` honest when the mute didn't come from OUR toggle —
            // an op's server-mute would otherwise be invisible to the mutee
            // (icon still live, no feedback at all). selfMuteInFlight excludes
            // our own toggle, whose TrackMuted lands before its await resolves.
            if (
              !selfMuteInFlight &&
              String(pub.source) === 'microphone' &&
              participant.identity === r.localParticipant.identity &&
              !this.muted
            ) {
              this.muted = true;
              this.error = OP_MUTED_MSG;
            }
          })
          .on(RoomEvent.TrackUnmuted, (pub, participant) => {
            // Self-unmute after a server mute is ALLOWED on self-hosted
            // LiveKit (mute-locking is a Cloud feature) — sync the state and
            // retire the op-mute notice rather than leaving it lying around.
            if (
              String(pub.source) === 'microphone' &&
              participant.identity === r.localParticipant.identity
            ) {
              this.muted = false;
              if (this.error === OP_MUTED_MSG) this.error = null;
            }
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
        if (!listenOnly) await r.localParticipant.setMicrophoneEnabled(true);
        this.active = true;
        this.muted = listenOnly;
        this.error = null;
        this.syncParticipants();
      } catch (e: unknown) {
        // Order matters: cleanup() clears `error` (so leaving a call never
        // strands the bar open on a stale message) — set the failure reason
        // AFTER it so the failed-call state still says why.
        await this.cleanup();
        this.error = e instanceof Error ? e.message : 'could not connect';
      } finally {
        this.connecting = false;
      }
    },

    syncParticipants() {
      this.participants = room
        ? Array.from(room.remoteParticipants.values()).map((p) => p.identity)
        : [];
    },

    addTile(identity: string, source: VideoSource, self: boolean) {
      if (!this.videoTiles.some((t) => t.identity === identity && t.source === source)) {
        this.videoTiles.push({ identity, source, self });
      }
    },
    removeTile(identity: string, source: VideoSource) {
      this.videoTiles = this.videoTiles.filter(
        (t) => !(t.identity === identity && t.source === source),
      );
    },

    /** Attach a tile's track to its <video> element. VideoTile calls this on
     *  mount — required for adaptiveStream to actually deliver remote video. */
    attachVideo(identity: string, source: VideoSource, el: HTMLVideoElement, self: boolean) {
      const track = self
        ? localVideoTracks.get(source)
        : videoTracksByKey.get(`${identity}|${source}`);
      track?.attach(el);
    },
    detachVideo(identity: string, source: VideoSource, el: HTMLVideoElement, self: boolean) {
      const track = self
        ? localVideoTracks.get(source)
        : videoTracksByKey.get(`${identity}|${source}`);
      track?.detach(el);
    },

    async toggleCamera() {
      if (!room || !this.canPublish) return; // listen-only: video is publish too
      try {
        // Flags + tiles are driven by LocalTrackPublished/Unpublished, so
        // state stays correct even if the device fails mid-toggle.
        await room.localParticipant.setCameraEnabled(!this.cameraOn);
      } catch (e: unknown) {
        this.error = e instanceof Error ? e.message : 'could not toggle camera';
      }
    },

    async toggleScreen() {
      if (!room || !this.canPublish) return;
      try {
        // { audio: true } also captures screen/tab audio where the browser+OS
        // allow it (Chrome's "share tab audio"); it silently degrades to
        // video-only otherwise.
        await room.localParticipant.setScreenShareEnabled(!this.screenOn, { audio: true });
      } catch (e: unknown) {
        // NotAllowedError is the user cancelling the picker (or an OS-level
        // deny — indistinguishable, and silence is the right call for the
        // common cancel). Everything else — no capturable source, device
        // errors, SFU publish failures — must NOT die silently as if the user
        // changed their mind.
        if (e instanceof DOMException && e.name === 'NotAllowedError') return;
        this.error = e instanceof Error ? e.message : 'could not share screen';
      }
    },

    /** Set a remote participant's local playback volume (0..1). Kept in state so
     *  it survives a track re-subscribe within the same session. */
    setVolume(identity: string, volume: number) {
      const v = Math.max(0, Math.min(1, volume));
      this.volumes[identity] = v;
      tracksByIdentity.get(identity)?.setVolume(v);
    },

    async toggleMute() {
      if (!room || !this.canPublish) return; // listen-only: nothing to toggle
      // Flip state only after the SFU confirms. An optimistic flip that then
      // rejects (device error, mid-reconnect) would render the mic-slash icon
      // while the track is still transmitting — the worst kind of wrong.
      const wantMuted = !this.muted;
      selfMuteInFlight = true;
      try {
        await room.localParticipant.setMicrophoneEnabled(!wantMuted);
        this.muted = wantMuted;
      } catch (e: unknown) {
        this.error = e instanceof Error ? e.message : 'could not toggle mute';
      } finally {
        selfMuteInFlight = false;
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
      videoTracksByKey = new Map();
      localVideoTracks = new Map();
      this.active = false;
      this.connecting = false;
      this.muted = false;
      this.cameraOn = false;
      this.screenOn = false;
      this.videoTiles = [];
      this.participants = [];
      this.speaking = [];
      this.volumes = {};
      this.networkId = null;
      this.target = '';
      this.isGuest = false;
      this.canPublish = true;
      // In-call notices (op-mute, mute-toggle failures) die with the call —
      // otherwise the CallBar stays wedged open showing them after /leave.
      // startCall's catch re-sets its failure reason after calling this.
      this.error = null;
    },
  },
});
