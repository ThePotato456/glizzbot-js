import test from "node:test";
import assert from "node:assert/strict";
import {
  DaveVoiceTransport,
  formatVoiceTransportDiagnosticSnapshot,
  planPlaybackDispatch,
} from "../../src/services/voice/daveVoiceTransport.js";
import type { VoiceConnectionState } from "../../src/services/voice/voiceTransport.js";

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

function createRecoveryHarness(overrides: Record<string, unknown> = {}) {
  const states: VoiceConnectionState[] = [];
  const snapshots: Array<{ event: string; extra?: string }> = [];
  const gatewayPayloads: unknown[] = [];
  let disconnectCalls = 0;
  let websocketCloseCalls = 0;
  let websocketRemoveListenerCalls = 0;
  let sourcePauseCalls = 0;
  let sourceResumeCalls = 0;

  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    guildId: "guild-1",
    channelId: "voice-1",
    userId: "bot-1",
    callbacks: {
      onConnectionStateChange: (state: VoiceConnectionState) => states.push(state),
    },
    connectionState: "connected",
    playbackState: "playing",
    destroyed: false,
    recoveryAttempts: 0,
    recoveryTimer: null,
    recoveringReason: null,
    sessionId: "session-1",
    serverUpdate: {
      endpoint: "voice.example.test",
      token: "token-1",
    },
    endpoint: "voice.example.test",
    missedHeartbeats: 3,
    lastHeartbeatSentAt: Date.now(),
    wsPingMs: 42,
    ws: {
      readyState: 1,
      removeAllListeners: () => {
        websocketRemoveListenerCalls += 1;
      },
      close: () => {
        websocketCloseCalls += 1;
      },
    },
    udp: {
      ready: true,
    },
    playback: {
      paused: false,
      source: {
        pause: () => {
          sourcePauseCalls += 1;
        },
        resume: () => {
          sourceResumeCalls += 1;
        },
      },
    },
    heartbeatInterval: null,
    setSpeaking: () => undefined,
    maybeOpenWebSocket: () => undefined,
    logTransportSnapshot: (event: string, extra?: string) => {
      snapshots.push({ event, extra });
    },
    disconnect: () => {
      disconnectCalls += 1;
      transport.connectionState = "disconnected";
    },
    sendJson: (op: number, data: unknown) => {
      gatewayPayloads.push({ op, data });
    },
    isPlaybackReady: () => transport.connectionState !== "recovering",
    ...overrides,
  });

  return {
    transport,
    states,
    snapshots,
    gatewayPayloads,
    get disconnectCalls() {
      return disconnectCalls;
    },
    get websocketCloseCalls() {
      return websocketCloseCalls;
    },
    get websocketRemoveListenerCalls() {
      return websocketRemoveListenerCalls;
    },
    get sourcePauseCalls() {
      return sourcePauseCalls;
    },
    get sourceResumeCalls() {
      return sourceResumeCalls;
    },
    clearRecoveryTimer: () => {
      if (transport.recoveryTimer) {
        clearTimeout(transport.recoveryTimer);
        transport.recoveryTimer = null;
      }
    },
  };
}

test("recoverable transport loss enters recovering without leaving voice", () => {
  const harness = createRecoveryHarness();

  const recovered = harness.transport.handleRecoverableTransportLoss("ws-close:1006:none");
  harness.clearRecoveryTimer();

  assert.equal(recovered, true);
  assert.equal(harness.transport.connectionState, "recovering");
  assert.deepEqual(harness.states, ["recovering"]);
  assert.equal(harness.disconnectCalls, 0);
  assert.equal(harness.websocketRemoveListenerCalls, 1);
  assert.equal(harness.websocketCloseCalls, 1);
  assert.equal(harness.transport.ws, null);
  assert.equal(harness.transport.udp?.ready, true);
  assert.equal(harness.sourcePauseCalls, 1);
  assert.equal(harness.snapshots[0]?.event, "recovery-start");
  assert.match(harness.snapshots[0]?.extra ?? "", /attempt:1/);
});

test("heartbeat timeout can enter recovery without full disconnect", async () => {
  const harness = createRecoveryHarness({
    sendJson: () => undefined,
  });

  harness.transport.startHeartbeat(1);
  await new Promise((resolve) => setTimeout(resolve, 15));
  harness.clearRecoveryTimer();
  if (harness.transport.heartbeatInterval) {
    clearInterval(harness.transport.heartbeatInterval);
    harness.transport.heartbeatInterval = null;
  }

  assert.equal(harness.transport.connectionState, "recovering");
  assert.equal(harness.disconnectCalls, 0);
  assert.ok(harness.snapshots.some((snapshot) => snapshot.event === "heartbeat-timeout"));
  assert.ok(harness.snapshots.some((snapshot) => snapshot.event === "recovery-start"));
});

test("recoverable loss is fatal while initial voice join is still connecting", () => {
  const harness = createRecoveryHarness({
    connectionState: "connecting",
  });

  const recovered = harness.transport.handleRecoverableTransportLoss("ws-close:1006:none");

  assert.equal(recovered, false);
  assert.equal(harness.transport.connectionState, "connecting");
  assert.equal(harness.disconnectCalls, 0);
  assert.deepEqual(harness.states, []);
});

test("adapter destroy and channel-null state still use full disconnect", () => {
  const harness = createRecoveryHarness();

  harness.transport.disconnect();

  assert.equal(harness.disconnectCalls, 1);
  assert.equal(harness.transport.connectionState, "disconnected");
});

test("recovery success returns to connected and resumes playback readiness", () => {
  const harness = createRecoveryHarness({
    connectionState: "recovering",
    recoveryAttempts: 1,
    recoveringReason: "ws-close:1006:none",
  });

  harness.transport.handleRecoverySuccess("resumed");

  assert.equal(harness.transport.connectionState, "connected");
  assert.deepEqual(harness.states, ["connected"]);
  assert.equal(harness.transport.recoveryAttempts, 0);
  assert.equal(harness.sourceResumeCalls, 1);
  assert.equal(harness.snapshots[0]?.event, "recovery-resumed");
});

test("recovery exhaustion performs full disconnect", () => {
  const harness = createRecoveryHarness({
    recoveryAttempts: 3,
  });

  const recovered = harness.transport.handleRecoverableTransportLoss("ws-close:1006:none");

  assert.equal(recovered, true);
  assert.equal(harness.disconnectCalls, 1);
  assert.equal(harness.snapshots[0]?.event, "recovery-exhausted");
});
