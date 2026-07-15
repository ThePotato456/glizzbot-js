import test from "node:test";
import assert from "node:assert/strict";
import {
  DaveVoiceTransport,
  formatVoiceTransportDiagnosticSnapshot,
  planPlaybackDispatch,
  shouldLogPlaybackTickerExit,
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

test("playback ticker exit logging ignores intentional and stale worker termination", () => {
  assert.equal(shouldLogPlaybackTickerExit(1, true, true), false);
  assert.equal(shouldLogPlaybackTickerExit(1, false, false), false);
  assert.equal(shouldLogPlaybackTickerExit(0, true, false), false);
  assert.equal(shouldLogPlaybackTickerExit(1, true, false), true);
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
    daveSessionStatus: 3,
    daveEpoch: "7",
    davePendingTransitions: 1,
    daveRecognizedUsers: 4,
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
  assert.match(line, /status:3,epoch:7,transitions:1,recognized:4/);
  assert.match(line, /heartbeat=missed:2,lastAgeMs:1234,pingMs:52,seq:25/);
  assert.match(line, /playbackId=track-1/);
  assert.match(line, /buffer=12/);
  assert.match(line, /extra=code:1006,reason:none/);
});

test("voice transport rejects malformed DAVE JSON before mutating session state", () => {
  const logs: string[] = [];
  let prepareTransitionCalls = 0;
  let executeTransitionCalls = 0;
  let prepareEpochCalls = 0;
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    daveSession: {
      maxProtocolVersion: 1,
      handlePrepareTransition: () => { prepareTransitionCalls += 1; return []; },
      handleExecuteTransition: () => { executeTransitionCalls += 1; return []; },
      handlePrepareEpoch: () => { prepareEpochCalls += 1; return []; },
    },
    log: (message: string) => { logs.push(message); },
  });

  transport.handleDavePrepareTransition({ transition_id: -1, protocol_version: 1 });
  transport.handleDaveExecuteTransition({ transition_id: "invalid" });
  transport.handleDavePrepareEpoch({ epoch: 0, protocol_version: 1 });

  assert.equal(prepareTransitionCalls, 0);
  assert.equal(executeTransitionCalls, 0);
  assert.equal(prepareEpochCalls, 0);
  assert.equal(logs.length, 3);
  assert.ok(logs.every((message) => message.includes("[DAVE] Rejected")));
});

test("Davey media encryption failures stop playback and retain its playback ID", () => {
  const errors: Array<{ error: Error; playbackId: string | null }> = [];
  const snapshots: string[] = [];
  let stopCalls = 0;
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    udp: {},
    secretKey: new Uint8Array(32),
    encryptionMode: "aead_aes256_gcm_rtpsize",
    sequence: 1,
    timestamp: 1,
    ssrc: 1,
    daveSession: {
      ready: true,
      encryptOpus: () => { throw new Error("encrypt failed"); },
    },
    playback: { playbackId: "track-1" },
    callbacks: {
      onPlaybackError: (error: Error, playbackId: string | null) => errors.push({ error, playbackId }),
    },
    log: () => undefined,
    logTransportSnapshot: (event: string) => { snapshots.push(event); },
    stop: () => {
      stopCalls += 1;
      transport.playback = null;
    },
  });

  const sent = transport.sendOpusFrame(Buffer.from([0x01]));

  assert.equal(sent, false);
  assert.equal(stopCalls, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.playbackId, "track-1");
  assert.match(errors[0]?.error.message ?? "", /encrypt failed/);
  assert.deepEqual(snapshots, ["dave-encryption-failed"]);
});

test("DAVE encrypts silence and announces speaking before sending UDP audio", () => {
  const events: string[] = [];
  const encryptedFrames: Buffer[] = [];
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    udp: {},
    secretKey: new Uint8Array(32),
    encryptionMode: "aead_aes256_gcm_rtpsize",
    sequence: 1,
    timestamp: 1,
    ssrc: 1,
    daveSession: {
      ready: true,
      encryptOpus: (frame: Buffer) => {
        encryptedFrames.push(frame);
        return Buffer.concat([Buffer.from("dave:"), frame]);
      },
    },
    encryptTransportPacket: () => ({ cipherText: Buffer.from([0x01]), noncePadding: Buffer.alloc(4) }),
    setSpeaking: () => { events.push("speaking"); return true; },
    sendUdpPacket: () => { events.push("udp"); },
  });

  const sent = transport.sendOpusFrame(Buffer.from([248, 255, 254]));

  assert.equal(sent, true);
  assert.deepEqual(encryptedFrames, [Buffer.from([248, 255, 254])]);
  assert.deepEqual(events, ["speaking", "udp"]);
});

test("protocol version zero sends transport-encrypted Opus without Davey encryption", () => {
  let daveEncryptCalls = 0;
  let udpCalls = 0;
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    udp: {},
    secretKey: new Uint8Array(32),
    encryptionMode: "aead_aes256_gcm_rtpsize",
    sequence: 1,
    timestamp: 1,
    ssrc: 1,
    daveSession: {
      ready: false,
      encryptOpus: () => { daveEncryptCalls += 1; return Buffer.alloc(0); },
    },
    encryptTransportPacket: () => ({ cipherText: Buffer.from([0x01]), noncePadding: Buffer.alloc(4) }),
    setSpeaking: () => true,
    sendUdpPacket: () => { udpCalls += 1; },
  });

  assert.equal(transport.sendOpusFrame(Buffer.from([0x01])), true);
  assert.equal(daveEncryptCalls, 0);
  assert.equal(udpCalls, 1);
});

test("voice v8 resume payload includes the latest gateway sequence", () => {
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    guildId: "guild-1",
    sessionId: "session-1",
    serverUpdate: { token: "token-1" },
    lastGatewaySequence: 42,
  });

  assert.deepEqual(transport.buildResumePayload(), {
    server_id: "guild-1",
    session_id: "session-1",
    token: "token-1",
    seq_ack: 42,
  });

  transport.lastGatewaySequence = -1;
  assert.equal("seq_ack" in transport.buildResumePayload(), false);

  transport.lastGatewaySequence = 0xffff;
  assert.equal(transport.buildResumePayload().seq_ack, 0xffff);
});

test("closed voice WebSocket clears local speaking state for recovery", () => {
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    speaking: true,
    ws: null,
  });

  assert.equal(transport.setSpeaking(false), true);
  assert.equal(transport.speaking, false);
  assert.equal(transport.setSpeaking(true), false);
});

test("structured Davey failures pause playback and emit contextual diagnostics", () => {
  const snapshots: Array<{ event: string; extra?: string }> = [];
  let pauseCalls = 0;
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    playback: { source: { pause: () => { pauseCalls += 1; } } },
    speaking: false,
    ws: null,
    log: () => undefined,
    logTransportSnapshot: (event: string, extra?: string) => snapshots.push({ event, extra }),
  });

  const succeeded = transport.applyDaveActions([{
    kind: "failure",
    operation: "initialize-session-or-key-package",
    message: "native failure",
    protocolVersion: 1,
    transitionId: 42,
  }]);

  assert.equal(succeeded, false);
  assert.equal(pauseCalls, 1);
  assert.equal(snapshots[0]?.event, "dave-operation-failed");
  assert.match(snapshots[0]?.extra ?? "", /protocolVersion:1/);
  assert.match(snapshots[0]?.extra ?? "", /transitionId:42/);
});

test("DAVE readiness timeout records context and performs labeled teardown", () => {
  const snapshots: Array<{ event: string; extra?: string }> = [];
  const disconnectReasons: string[] = [];
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  Object.assign(transport, {
    playback: {},
    destroyed: false,
    daveSession: {
      currentProtocolVersion: 1,
      currentSessionStatus: 2,
      pendingTransitionCount: 1,
    },
    isPlaybackReady: () => false,
    logTransportSnapshot: (event: string, extra?: string) => snapshots.push({ event, extra }),
    disconnect: (reason: string) => { disconnectReasons.push(reason); },
  });

  transport.handleDaveReadinessTimeout();

  assert.equal(snapshots[0]?.event, "dave-readiness-timeout");
  assert.match(snapshots[0]?.extra ?? "", /pendingTransitions:1/);
  assert.deepEqual(disconnectReasons, ["dave-readiness-timeout"]);
});

test("DAVE Clients Connect accepts singular and array user payloads", () => {
  const transport = Object.create(DaveVoiceTransport.prototype) as any;

  assert.deepEqual(transport.getDaveConnectedUserIds({ user_id: "user-1" }), ["user-1"]);
  assert.deepEqual(transport.getDaveConnectedUserIds({ user_ids: ["user-1", 2, "user-2"] }), ["user-1", "user-2"]);
});

test("fresh session-description recovery resumes immediately after DAVE readiness", () => {
  const harness = createRecoveryHarness({
    connectionState: "recovering",
    recoveryAttempts: 1,
    recoveringReason: "resume-fallback",
  });

  harness.transport.handleRecoverySuccess("session-description");

  assert.equal(harness.transport.connectionState, "connected");
  assert.equal(harness.sourceResumeCalls, 1);
  assert.equal(harness.transport.recoveryReconcileTimer, null);
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
    recoveryReconcileTimer: null,
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
    daveSession: { ready: true },
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
  assert.equal(harness.sourceResumeCalls, 0);
  assert.equal(harness.snapshots[0]?.event, "recovery-resumed");

  if (harness.transport.recoveryReconcileTimer) {
    clearTimeout(harness.transport.recoveryReconcileTimer);
    harness.transport.recoveryReconcileTimer = null;
  }
  harness.transport.completeRecoveryReconciliation();
  assert.equal(harness.sourceResumeCalls, 1);
  assert.equal(harness.snapshots[1]?.event, "recovery-reconciled");
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

test("call-terminated close performs fatal teardown instead of resume recovery", () => {
  const harness = createRecoveryHarness({
    rejectConnect: () => undefined,
    log: () => undefined,
  });

  harness.transport.handleVoiceWebSocketClose(4022, "Disconnected: Call terminated.");

  assert.equal(harness.disconnectCalls, 1);
  assert.equal(harness.transport.recoveryTimer, null);
  assert.ok(harness.snapshots.some((snapshot) => snapshot.event === "ws-close"));
  assert.ok(!harness.snapshots.some((snapshot) => snapshot.event === "recovery-start"));
});

test("invalid resumed session retries with a fresh identify handshake", () => {
  const harness = createRecoveryHarness({
    connectionState: "recovering",
    recoveryAttempts: 1,
    recoveryHandshake: "resume",
    ws: null,
    rejectConnect: () => undefined,
    log: () => undefined,
  });

  harness.transport.handleVoiceWebSocketClose(4006, "Session is no longer valid.");
  harness.clearRecoveryTimer();

  assert.equal(harness.disconnectCalls, 0);
  assert.equal(harness.transport.recoveryAttempts, 2);
  assert.equal(harness.transport.recoveryHandshake, "identify");
  assert.ok(harness.snapshots.some((snapshot) => snapshot.extra?.includes("handshake:identify")));
});

test("voice authentication tokens are redacted from diagnostic payloads", () => {
  const transport = Object.create(DaveVoiceTransport.prototype) as any;
  const payload = {
    server_id: "guild-1",
    session_id: "session-1",
    token: "secret-token",
  };

  assert.deepEqual(transport.redactVoiceCredentials(7, payload), {
    ...payload,
    token: "[REDACTED]",
  });
  assert.deepEqual(transport.redactVoiceCredentials(3, payload), payload);
});
