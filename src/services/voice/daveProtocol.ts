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
}

export type DaveGatewayAction =
  | DaveGatewayJsonAction
  | DaveGatewayBinaryAction
  | DaveGatewayLogAction;
