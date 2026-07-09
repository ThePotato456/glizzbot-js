import test from "node:test";
import assert from "node:assert/strict";
import {
  formatVoiceTransportDiagnosticSnapshot,
  planPlaybackDispatch,
} from "../../src/services/voice/daveVoiceTransport.js";

test("planPlaybackDispatch waits when the scheduler wakes too early", () => {
  const plan = planPlaybackDispatch(99, 100);

  assert.equal(plan.shouldSendFrame, false);
  assert.equal(plan.framesToDrop, 0);
  assert.equal(plan.nextDispatchAt, 100);
  assert.equal(plan.resynchronized, false);
});

test("planPlaybackDispatch sends a single frame on time", () => {
  const plan = planPlaybackDispatch(120, 120);

  assert.equal(plan.shouldSendFrame, true);
  assert.equal(plan.framesToDrop, 0);
  assert.equal(plan.nextDispatchAt, 140);
  assert.equal(plan.resynchronized, false);
});

test("planPlaybackDispatch drops overdue frames for moderate lateness", () => {
  const plan = planPlaybackDispatch(165, 120);

  assert.equal(plan.shouldSendFrame, true);
  assert.equal(plan.framesToDrop, 2);
  assert.equal(plan.nextDispatchAt, 185);
  assert.equal(plan.resynchronized, true);
});

test("planPlaybackDispatch caps frame dropping when the scheduler is very late", () => {
  const plan = planPlaybackDispatch(260, 120);

  assert.equal(plan.shouldSendFrame, true);
  assert.equal(plan.framesToDrop, 4);
  assert.equal(plan.nextDispatchAt, 280);
  assert.equal(plan.resynchronized, true);
});

test("formatVoiceTransportDiagnosticSnapshot includes transport failure context", () => {
  const line = formatVoiceTransportDiagnosticSnapshot({
    event: "ws-close",
    guildId: "guild-1",
    channelId: "voice-1",
    endpoint: "voice.example.test",
    sessionId: "session-1",
    connectionState: "connected",
    playbackState: "playing",
    destroyed: false,
    wsState: "closed",
    udpReady: true,
    udpRemote: "127.0.0.1:5000",
    daveProtocolVersion: 1,
    daveReady: true,
    davePrivacyCode: "privacy-code",
    missedHeartbeats: 2,
    lastHeartbeatAgeMs: 1234,
    wsPingMs: 52,
    lastGatewaySequence: 25,
    playbackActive: true,
    playbackId: "track-1",
    playbackBufferedFrames: 12,
    playbackEnded: false,
    playbackPaused: false,
    speaking: true,
    ssrc: 3450,
    encryptionMode: "aead_xchacha20_poly1305_rtpsize",
    extra: "code:1006,reason:none",
  });

  assert.match(line, /event=ws-close/);
  assert.match(line, /guild=guild-1/);
  assert.match(line, /channel=voice-1/);
  assert.match(line, /connection=connected/);
  assert.match(line, /playback=playing/);
  assert.match(line, /dave=v1:ready:privacy-code/);
  assert.match(line, /heartbeat=missed:2,lastAgeMs:1234,pingMs:52,seq:25/);
  assert.match(line, /playbackId=track-1/);
  assert.match(line, /buffer=12/);
  assert.match(line, /extra=code:1006,reason:none/);
});
