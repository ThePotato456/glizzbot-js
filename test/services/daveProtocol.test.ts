import test from "node:test";
import assert from "node:assert/strict";
import {
  VoiceOpcode,
  parseDaveBinaryPacket,
  parseDaveExecuteTransitionPayload,
  parseDavePrepareEpochPayload,
  parseDavePrepareTransitionPayload,
} from "../../src/services/voice/daveProtocol.js";

test("DAVE JSON payload parsers accept valid transition data", () => {
  assert.deepEqual(parseDavePrepareTransitionPayload({
    transition_id: 42,
    protocol_version: 1,
  }, 1), {
    ok: true,
    value: { transition_id: 42, protocol_version: 1 },
  });
  assert.deepEqual(parseDaveExecuteTransitionPayload({ transition_id: 42 }), {
    ok: true,
    value: { transition_id: 42 },
  });
  assert.deepEqual(parseDavePrepareEpochPayload({
    transition_id: 42,
    epoch: 1,
    protocol_version: 1,
  }, 1), {
    ok: true,
    value: { transition_id: 42, epoch: 1, protocol_version: 1 },
  });
});

test("DAVE JSON payload parsers reject malformed and unsupported data", () => {
  const results = [
    parseDavePrepareTransitionPayload(null, 1),
    parseDavePrepareTransitionPayload({ transition_id: -1, protocol_version: 1 }, 1),
    parseDavePrepareTransitionPayload({ transition_id: 1, protocol_version: 2 }, 1),
    parseDaveExecuteTransitionPayload({ transition_id: 1.5 }),
    parseDavePrepareEpochPayload({ epoch: 0, protocol_version: 1 }, 1),
    parseDavePrepareEpochPayload({ epoch: 1, protocol_version: -1 }, 1),
  ];

  for (const result of results) {
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.error.length > 0);
    }
  }
});

test("DAVE binary parser returns typed packets for supported opcodes", () => {
  const proposals = parseDaveBinaryPacket(Buffer.from([
    0x00, 0x09, VoiceOpcode.MLS_PROPOSALS, 0x01, 0xaa,
  ]));
  assert.equal(proposals.ok, true);
  if (proposals.ok) {
    assert.equal(proposals.value.kind, "proposals");
    assert.equal(proposals.value.sequence, 9);
    if (proposals.value.kind === "proposals") {
      assert.equal(proposals.value.operationType, 1);
      assert.deepEqual(proposals.value.payload, Buffer.from([0xaa]));
    }
  }

  const welcome = parseDaveBinaryPacket(Buffer.from([
    0x00, 0x0a, VoiceOpcode.MLS_WELCOME, 0x00, 0x2a, 0xbb,
  ]));
  assert.equal(welcome.ok, true);
  if (welcome.ok && welcome.value.kind === "welcome") {
    assert.equal(welcome.value.transitionId, 42);
    assert.deepEqual(welcome.value.payload, Buffer.from([0xbb]));
  } else {
    assert.fail("Expected a parsed DAVE welcome packet.");
  }
});

test("DAVE binary parser safely rejects truncated opcode payloads", () => {
  const malformedPackets = [
    Buffer.alloc(0),
    Buffer.from([0x00]),
    Buffer.from([0x00, 0x01]),
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_EXTERNAL_SENDER]),
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_PROPOSALS]),
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_PROPOSALS, 0x00]),
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_PROPOSALS, 0xff]),
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION]),
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION, 0x00]),
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION, 0x00, 0x2a]),
    Buffer.from([0x00, 0x01, VoiceOpcode.MLS_WELCOME, 0x00, 0x2a]),
  ];

  for (const packet of malformedPackets) {
    assert.doesNotThrow(() => parseDaveBinaryPacket(packet));
    assert.equal(parseDaveBinaryPacket(packet).ok, false, `Expected ${packet.toString("hex")} to be rejected`);
  }
});

test("DAVE binary parser retains unsupported opcodes without interpreting their payload", () => {
  const result = parseDaveBinaryPacket(Buffer.from([0x00, 0x07, 0xff, 0xaa]));

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.kind, "unsupported");
    assert.equal(result.value.opcode, 0xff);
    assert.deepEqual(result.value.payload, Buffer.from([0xaa]));
  }
});
