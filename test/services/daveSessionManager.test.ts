import test from "node:test";
import assert from "node:assert/strict";
import type { ProposalsOperationType, SessionStatus } from "@snazzah/davey";
import { DaveSessionManager } from "../../src/services/voice/daveSessionManager.js";
import { VoiceOpcode } from "../../src/services/voice/daveProtocol.js";

class FakeDaveSession {
  ready = false;
  status = 1 as SessionStatus;
  voicePrivacyCode = "";
  reinitCalls: Array<{ protocolVersion: number; userId: string; channelId: string }> = [];
  resetCalls = 0;
  passthroughCalls: Array<{ enabled: boolean; expiry?: number | null }> = [];
  externalSender: Buffer | null = null;
  serializedKeyPackage = Buffer.from("key-package");
  proposalRecognizedUserIds: Array<string[] | null | undefined> = [];
  throwUnexpectedUserOnFirstProposal = false;
  throwOnExternalSender = false;
  throwOnReinit = false;
  throwOnReset = false;
  throwOnKeyPackage = false;
  throwOnCommit = false;
  throwOnWelcome = false;
  throwOnProposal = false;
  commitPayloads: Buffer[] = [];
  welcomePayloads: Buffer[] = [];

  reinit(protocolVersion: number, userId: string, channelId: string): void {
    if (this.throwOnReinit) {
      throw new Error("reinit failed");
    }
    this.reinitCalls.push({ protocolVersion, userId, channelId });
    this.ready = false;
    this.status = 1 as SessionStatus;
  }

  reset(): void {
    if (this.throwOnReset) {
      throw new Error("reset failed");
    }
    this.resetCalls += 1;
    this.ready = false;
    this.status = 0 as SessionStatus;
  }

  setExternalSender(externalSenderData: Buffer): void {
    if (this.throwOnExternalSender) {
      throw new Error("external sender failed");
    }
    this.externalSender = externalSenderData;
  }

  getSerializedKeyPackage(): Buffer {
    if (this.throwOnKeyPackage) {
      throw new Error("key package failed");
    }
    return this.serializedKeyPackage;
  }

  processProposals(
    _operationType: ProposalsOperationType,
    _proposals: Buffer,
    recognizedUserIds?: string[] | null,
  ): { commit?: Buffer; welcome?: Buffer } {
    this.proposalRecognizedUserIds.push(recognizedUserIds);
    if (this.throwOnProposal) {
      throw new Error("proposal failed");
    }
    if (this.throwUnexpectedUserOnFirstProposal && this.proposalRecognizedUserIds.length === 1) {
      throw new Error("Failed to process proposals: UnexpectedUser(1046875695575486514)");
    }
    this.status = 2 as SessionStatus;
    return {
      commit: Buffer.from("commit"),
      welcome: Buffer.from("welcome"),
    };
  }

  processCommit(commit: Buffer): void {
    if (this.throwOnCommit) {
      throw new Error("commit failed");
    }
    this.commitPayloads.push(commit);
    this.ready = true;
    this.status = 3 as SessionStatus;
  }

  processWelcome(welcome: Buffer): void {
    if (this.throwOnWelcome) {
      throw new Error("welcome failed");
    }
    this.welcomePayloads.push(welcome);
    this.ready = true;
    this.status = 3 as SessionStatus;
  }

  setPassthroughMode(passthroughMode: boolean, transitionExpiry?: number | null): void {
    this.passthroughCalls.push({ enabled: passthroughMode, expiry: transitionExpiry });
  }

  encryptOpus(packet: Buffer): Buffer {
    return Buffer.concat([Buffer.from("enc:"), packet]);
  }

  decrypt(_userId: string, _mediaType: number, packet: Buffer): Buffer {
    return packet.subarray(4);
  }

  canPassthrough(_userId: string): boolean {
    return true;
  }

  getUserIds(): string[] {
    return ["user-1", "user-2"];
  }
}

test("handleSessionDescription emits an MLS key package for active DAVE sessions", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager(
    "self-user",
    "voice-channel",
    () => fakeSession,
  );

  const actions = manager.handleSessionDescription(1);

  assert.equal(manager.currentProtocolVersion, 1);
  assert.equal(actions.some((action) => action.kind === "send-binary" && action.op === VoiceOpcode.MLS_KEY_PACKAGE), true);
});

test("handlePrepareTransition records a downgrade and readies the transition", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager(
    "self-user",
    "voice-channel",
    () => fakeSession,
  );
  manager.handleSessionDescription(1);

  const actions = manager.handlePrepareTransition({
    transition_id: 42,
    protocol_version: 0,
  });

  assert.deepEqual(fakeSession.passthroughCalls.at(-1), { enabled: true, expiry: 120 });
  assert.equal(actions.some((action) => action.kind === "send-json" && action.op === VoiceOpcode.DAVE_TRANSITION_READY), true);
});

test("handleBinaryMessage stores the external sender payload", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager(
    "self-user",
    "voice-channel",
    () => fakeSession,
  );
  manager.handleSessionDescription(1);

  const message = Buffer.concat([
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_EXTERNAL_SENDER]),
    Buffer.from("sender"),
  ]);
  manager.handleBinaryMessage(message);

  assert.equal(fakeSession.externalSender?.toString("utf8"), "sender");
});

test("handleBinaryMessage creates an MLS commit+welcome send action from proposals", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager(
    "self-user",
    "voice-channel",
    () => fakeSession,
  );
  manager.handleSessionDescription(1);

  const message = Buffer.concat([
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_PROPOSALS, 0x00]),
    Buffer.from("proposal-bytes"),
  ]);
  const actions = manager.handleBinaryMessage(message);

  const binaryAction = actions.find((action) => action.kind === "send-binary");
  assert.ok(binaryAction);
  assert.equal(binaryAction.kind, "send-binary");
  assert.equal(binaryAction.op, VoiceOpcode.MLS_COMMIT_WELCOME);
  assert.equal(binaryAction.body.toString("utf8"), "commitwelcome");
});

test("handleBinaryMessage retries proposals without recognized users after unexpected-user errors", () => {
  const fakeSession = new FakeDaveSession();
  fakeSession.throwUnexpectedUserOnFirstProposal = true;
  const manager = new DaveSessionManager(
    "self-user",
    "voice-channel",
    () => fakeSession,
    (userId) => userId === "1046875695575486514",
  );
  manager.handleSessionDescription(1);
  manager.setRecognizedUserIds(["self-user"]);

  const message = Buffer.concat([
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_PROPOSALS, 0x00]),
    Buffer.from("proposal-bytes"),
  ]);
  const actions = manager.handleBinaryMessage(message);

  assert.equal(fakeSession.proposalRecognizedUserIds.length, 2);
  assert.deepEqual(fakeSession.proposalRecognizedUserIds[0], ["self-user"]);
  assert.deepEqual(fakeSession.proposalRecognizedUserIds[1], ["self-user", "1046875695575486514"]);
  assert.equal(actions.some((action) => action.kind === "send-binary" && action.op === VoiceOpcode.MLS_COMMIT_WELCOME), true);
});

test("handleBinaryMessage rejects unexpected users that are not in the voice channel", () => {
  const fakeSession = new FakeDaveSession();
  fakeSession.throwUnexpectedUserOnFirstProposal = true;
  const manager = new DaveSessionManager(
    "self-user",
    "voice-channel",
    () => fakeSession,
    () => false,
  );
  manager.handleSessionDescription(1);
  manager.setRecognizedUserIds(["self-user"]);

  const actions = manager.handleBinaryMessage(Buffer.from([
    0x00, 0x01, VoiceOpcode.MLS_PROPOSALS, 0x00, 0xaa,
  ]));

  assert.equal(fakeSession.proposalRecognizedUserIds.length, 1);
  assert.equal(actions.some((action) => action.kind === "send-binary"), false);
  assert.equal(actions.some((action) => action.kind === "log" && action.level === "warn"), true);
});

test("handleBinaryMessage rejects malformed packets without invoking Davey", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);

  const actions = manager.handleBinaryMessage(Buffer.from([
    0x00, 0x01, VoiceOpcode.MLS_PROPOSALS,
  ]));

  assert.equal(fakeSession.proposalRecognizedUserIds.length, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.kind, "log");
  if (actions[0]?.kind === "log") {
    assert.equal(actions[0].level, "warn");
  }
});

test("handleSessionDescription ignores unsupported protocol versions without creating a session", () => {
  let factoryCalls = 0;
  const manager = new DaveSessionManager("self-user", "voice-channel", () => {
    factoryCalls += 1;
    return new FakeDaveSession();
  });

  const actions = manager.handleSessionDescription(manager.maxProtocolVersion + 1);

  assert.equal(factoryCalls, 0);
  assert.equal(manager.currentProtocolVersion, 0);
  assert.equal(actions[0]?.kind, "log");
  if (actions[0]?.kind === "log") {
    assert.equal(actions[0].level, "warn");
  }
});

test("Davey external sender failures become structured failure actions instead of escaping", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);
  fakeSession.throwOnExternalSender = true;

  const actions = manager.handleBinaryMessage(Buffer.from([
    0x00, 0x01, VoiceOpcode.MLS_EXTERNAL_SENDER, 0xaa,
  ]));

  assert.equal(actions.length, 1);
  assert.equal(actions[0]?.kind, "failure");
  if (actions[0]?.kind === "failure") {
    assert.equal(actions[0].operation, "set-external-sender");
    assert.match(actions[0].message, /external sender failed/);
    assert.equal(actions[0].protocolVersion, 1);
  }
});

test("Davey key package failures become warning actions instead of escaping", () => {
  const fakeSession = new FakeDaveSession();
  fakeSession.throwOnKeyPackage = true;
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);

  const actions = manager.handleSessionDescription(1);

  assert.equal(manager.ready, false);
  assert.equal(actions.some((action) => action.kind === "send-binary"), false);
  assert.equal(actions.some((action) => action.kind === "failure" && action.operation === "initialize-session-or-key-package"), true);
});

test("Davey reset failures become warning actions instead of escaping", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);
  fakeSession.throwOnReset = true;

  const actions = manager.handleSessionDescription(0);

  assert.equal(actions.some((action) => action.kind === "failure" && action.operation === "reset-session"), true);
});

test("Davey proposal, commit, and reinitialization failures remain contained", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);

  fakeSession.throwOnProposal = true;
  const proposalActions = manager.handleBinaryMessage(Buffer.from([
    0x00, 0x01, VoiceOpcode.MLS_PROPOSALS, 0x00, 0xaa,
  ]));
  assert.equal(proposalActions.some((action) => action.kind === "log" && action.level === "warn"), true);

  fakeSession.throwOnProposal = false;
  fakeSession.throwOnCommit = true;
  const commitActions = manager.handleBinaryMessage(Buffer.from([
    0x00, 0x02, VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION, 0x00, 0x2a, 0xbb,
  ]));
  assert.equal(commitActions.some((action) => action.kind === "send-json" && action.op === VoiceOpcode.MLS_INVALID_COMMIT_WELCOME), true);

  fakeSession.throwOnCommit = false;
  fakeSession.throwOnReinit = true;
  const reinitActions = manager.handleSessionDescription(1);
  assert.equal(reinitActions.some((action) => action.kind === "failure" && action.operation === "initialize-session-or-key-package"), true);
});

test("fresh session descriptions discard stale pending transitions", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);
  manager.handlePrepareTransition({ transition_id: 42, protocol_version: 0 });

  manager.handleSessionDescription(1);
  const actions = manager.handleExecuteTransition({ transition_id: 42 });

  assert.equal(manager.currentProtocolVersion, 1);
  assert.equal(actions.some((action) => action.kind === "log" && action.level === "warn"), true);
});

test("DAVE commit and welcome packets prepare their transitions", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);

  const commitActions = manager.handleBinaryMessage(Buffer.from([
    0x00, 0x01, VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION, 0x00, 0x2a, 0xaa,
  ]));
  const welcomeActions = manager.handleBinaryMessage(Buffer.from([
    0x00, 0x02, VoiceOpcode.MLS_WELCOME, 0x00, 0x2b, 0xbb,
  ]));

  assert.deepEqual(fakeSession.commitPayloads, [Buffer.from([0xaa])]);
  assert.deepEqual(fakeSession.welcomePayloads, [Buffer.from([0xbb])]);
  assert.equal(commitActions.some((action) => action.kind === "send-json" && action.op === VoiceOpcode.DAVE_TRANSITION_READY), true);
  assert.equal(welcomeActions.some((action) => action.kind === "send-json" && action.op === VoiceOpcode.DAVE_TRANSITION_READY), true);
});

test("prepared MLS media remains gated until Discord executes the transition", () => {
  const fakeSession = new FakeDaveSession();
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);

  manager.handleBinaryMessage(Buffer.from([
    0x00, 0x01, VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION, 0x00, 0x2a, 0xaa,
  ]));
  assert.equal(fakeSession.ready, true);
  assert.equal(manager.ready, false);

  manager.handleExecuteTransition({ transition_id: 42 });
  assert.equal(manager.ready, true);
});

test("invalid DAVE welcome requests resynchronization and a fresh key package", () => {
  const fakeSession = new FakeDaveSession();
  fakeSession.throwOnWelcome = true;
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);

  const actions = manager.handleBinaryMessage(Buffer.from([
    0x00, 0x01, VoiceOpcode.MLS_WELCOME, 0x00, 0x2a, 0xbb,
  ]));

  assert.equal(actions.some((action) => action.kind === "send-json" && action.op === VoiceOpcode.MLS_INVALID_COMMIT_WELCOME), true);
  assert.equal(actions.some((action) => action.kind === "send-binary" && action.op === VoiceOpcode.MLS_KEY_PACKAGE), true);
  assert.equal(actions.some((action) => action.kind === "log" && action.event === "dave-mls-resync"), true);
});

test("epoch one reinitializes DAVE and protocol downgrade disables frame encryption", () => {
  const fakeSession = new FakeDaveSession();
  fakeSession.ready = true;
  const manager = new DaveSessionManager("self-user", "voice-channel", () => fakeSession);
  manager.handleSessionDescription(1);

  const epochActions = manager.handlePrepareEpoch({ transition_id: 10, epoch: 1, protocol_version: 1 });
  manager.handlePrepareTransition({ transition_id: 11, protocol_version: 0 });
  manager.handleExecuteTransition({ transition_id: 11 });
  const plaintext = Buffer.from([0x01, 0x02]);

  assert.equal(epochActions.some((action) => action.kind === "send-binary" && action.op === VoiceOpcode.MLS_KEY_PACKAGE), true);
  assert.equal(manager.currentProtocolVersion, 0);
  assert.equal(manager.encryptOpus(plaintext), plaintext);
});
