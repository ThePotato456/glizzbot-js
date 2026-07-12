export const enum VoiceOpcode {
  SESSION_DESCRIPTION = 4,
  CLIENTS_CONNECT = 11,
  CLIENT_DISCONNECT = 13,
  DAVE_PREPARE_TRANSITION = 21,
  DAVE_EXECUTE_TRANSITION = 22,
  DAVE_TRANSITION_READY = 23,
  DAVE_PREPARE_EPOCH = 24,
  MLS_EXTERNAL_SENDER = 25,
  MLS_KEY_PACKAGE = 26,
  MLS_PROPOSALS = 27,
  MLS_COMMIT_WELCOME = 28,
  MLS_ANNOUNCE_COMMIT_TRANSITION = 29,
  MLS_WELCOME = 30,
  MLS_INVALID_COMMIT_WELCOME = 31,
}

export interface DavePrepareTransitionPayload {
  transition_id: number;
  protocol_version: number;
}

export interface DaveExecuteTransitionPayload {
  transition_id: number;
}

export interface DavePrepareEpochPayload {
  transition_id?: number;
  epoch: number;
  protocol_version: number;
}

export type DavePayloadParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type DaveBinaryPacket =
  | {
      kind: "external-sender";
      sequence: number;
      opcode: VoiceOpcode.MLS_EXTERNAL_SENDER;
      payload: Buffer;
    }
  | {
      kind: "proposals";
      sequence: number;
      opcode: VoiceOpcode.MLS_PROPOSALS;
      operationType: 0 | 1;
      payload: Buffer;
    }
  | {
      kind: "commit" | "welcome";
      sequence: number;
      opcode: VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION | VoiceOpcode.MLS_WELCOME;
      transitionId: number;
      payload: Buffer;
    }
  | {
      kind: "unsupported";
      sequence: number;
      opcode: number;
      payload: Buffer;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseProtocolVersion(value: unknown, maxProtocolVersion: number): DavePayloadParseResult<number> {
  if (!isNonNegativeInteger(value)) {
    return { ok: false, error: "DAVE protocol version must be a non-negative integer." };
  }
  if (value > maxProtocolVersion) {
    return {
      ok: false,
      error: `DAVE protocol version ${value} exceeds supported version ${maxProtocolVersion}.`,
    };
  }
  return { ok: true, value };
}

export function parseDavePrepareTransitionPayload(
  value: unknown,
  maxProtocolVersion: number,
): DavePayloadParseResult<DavePrepareTransitionPayload> {
  if (!isRecord(value) || !isNonNegativeInteger(value.transition_id)) {
    return { ok: false, error: "DAVE prepare transition requires a non-negative transition_id." };
  }
  const protocolVersion = parseProtocolVersion(value.protocol_version, maxProtocolVersion);
  if (!protocolVersion.ok) {
    return protocolVersion;
  }
  return {
    ok: true,
    value: {
      transition_id: value.transition_id,
      protocol_version: protocolVersion.value,
    },
  };
}

export function parseDaveExecuteTransitionPayload(value: unknown): DavePayloadParseResult<DaveExecuteTransitionPayload> {
  if (!isRecord(value) || !isNonNegativeInteger(value.transition_id)) {
    return { ok: false, error: "DAVE execute transition requires a non-negative transition_id." };
  }
  return { ok: true, value: { transition_id: value.transition_id } };
}

export function parseDavePrepareEpochPayload(
  value: unknown,
  maxProtocolVersion: number,
): DavePayloadParseResult<DavePrepareEpochPayload> {
  if (!isRecord(value) || !isNonNegativeInteger(value.epoch) || value.epoch === 0) {
    return { ok: false, error: "DAVE prepare epoch requires a positive epoch." };
  }
  if (value.transition_id !== undefined && !isNonNegativeInteger(value.transition_id)) {
    return { ok: false, error: "DAVE prepare epoch transition_id must be a non-negative integer." };
  }
  const protocolVersion = parseProtocolVersion(value.protocol_version, maxProtocolVersion);
  if (!protocolVersion.ok) {
    return protocolVersion;
  }
  return {
    ok: true,
    value: {
      ...(value.transition_id === undefined ? {} : { transition_id: value.transition_id }),
      epoch: value.epoch,
      protocol_version: protocolVersion.value,
    },
  };
}

export function parseDaveBinaryPacket(message: Buffer): DavePayloadParseResult<DaveBinaryPacket> {
  if (message.length < 3) {
    return { ok: false, error: `DAVE binary packet is too short (${message.length} byte(s)); expected a 3-byte header.` };
  }

  const sequence = message.readUInt16BE(0);
  const opcode = message.readUInt8(2);
  if (opcode === VoiceOpcode.MLS_EXTERNAL_SENDER) {
    if (message.length < 4) {
      return { ok: false, error: "DAVE MLS external sender packet has an empty payload." };
    }
    return { ok: true, value: { kind: "external-sender", sequence, opcode, payload: message.subarray(3) } };
  }

  if (opcode === VoiceOpcode.MLS_PROPOSALS) {
    if (message.length < 4) {
      return { ok: false, error: "DAVE MLS proposals packet is missing its operation type." };
    }
    const operationType = message.readUInt8(3);
    if (operationType !== 0 && operationType !== 1) {
      return { ok: false, error: `DAVE MLS proposals packet has unsupported operation type ${operationType}.` };
    }
    if (message.length < 5) {
      return { ok: false, error: "DAVE MLS proposals packet has an empty proposals payload." };
    }
    return {
      ok: true,
      value: { kind: "proposals", sequence, opcode, operationType, payload: message.subarray(4) },
    };
  }

  if (opcode === VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION || opcode === VoiceOpcode.MLS_WELCOME) {
    if (message.length < 6) {
      return {
        ok: false,
        error: `DAVE MLS ${opcode === VoiceOpcode.MLS_WELCOME ? "welcome" : "commit"} packet is missing its transition ID or payload.`,
      };
    }
    return {
      ok: true,
      value: {
        kind: opcode === VoiceOpcode.MLS_WELCOME ? "welcome" : "commit",
        sequence,
        opcode,
        transitionId: message.readUInt16BE(3),
        payload: message.subarray(5),
      },
    };
  }

  return { ok: true, value: { kind: "unsupported", sequence, opcode, payload: message.subarray(3) } };
}

export interface DaveGatewayJsonAction {
  kind: "send-json";
  op: VoiceOpcode;
  data: Record<string, unknown>;
}

export interface DaveGatewayBinaryAction {
  kind: "send-binary";
  op: VoiceOpcode;
  body: Buffer;
}

export interface DaveGatewayLogAction {
  kind: "log";
  level: "debug" | "warn";
  message: string;
  event?: string;
  extra?: string;
}

export interface DaveGatewayFailureAction {
  kind: "failure";
  operation: string;
  message: string;
  protocolVersion: number;
  transitionId?: number;
}

export type DaveGatewayAction =
  | DaveGatewayJsonAction
  | DaveGatewayBinaryAction
  | DaveGatewayLogAction
  | DaveGatewayFailureAction;
