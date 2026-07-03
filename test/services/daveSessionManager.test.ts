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

  reinit(protocolVersion: number, userId: string, channelId: string): void {
    this.reinitCalls.push({ protocolVersion, userId, channelId });
  }

  reset(): void {
    this.resetCalls += 1;
  }

  setExternalSender(externalSenderData: Buffer): void {
    this.externalSender = externalSenderData;
  }

  getSerializedKeyPackage(): Buffer {
    return this.serializedKeyPackage;
  }

  processProposals(
    _operationType: ProposalsOperationType,
    _proposals: Buffer,
    recognizedUserIds?: string[] | null,
  ): { commit?: Buffer; welcome?: Buffer } {
    this.proposalRecognizedUserIds.push(recognizedUserIds);
    if (this.throwUnexpectedUserOnFirstProposal && this.proposalRecognizedUserIds.length === 1) {
      throw new Error("Failed to process proposals: UnexpectedUser(1046875695575486514)");
    }
    return {
      commit: Buffer.from("commit"),
      welcome: Buffer.from("welcome"),
    };
  }

  processCommit(_commit: Buffer): void {}

  processWelcome(_welcome: Buffer): void {}

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
  assert.equal(fakeSession.proposalRecognizedUserIds[1], null);
  assert.equal(actions.some((action) => action.kind === "send-binary" && action.op === VoiceOpcode.MLS_COMMIT_WELCOME), true);
});
