import {
  Codec,
  DAVESession,
  DAVE_PROTOCOL_VERSION,
  MediaType,
  ProposalsOperationType,
  type ProposalsResult,
  type SessionStatus,
} from "@snazzah/davey";
import {
  VoiceOpcode,
  type DaveExecuteTransitionPayload,
  type DaveGatewayAction,
  type DavePrepareEpochPayload,
  type DavePrepareTransitionPayload,
} from "./daveProtocol.js";

interface DaveSessionLike {
  readonly ready: boolean;
  readonly status: SessionStatus;
  readonly voicePrivacyCode: string;
  reinit(protocolVersion: number, userId: string, channelId: string): void;
  reset(): void;
  setExternalSender(externalSenderData: Buffer): void;
  getSerializedKeyPackage(): Buffer;
  processProposals(
    operationType: ProposalsOperationType,
    proposals: Buffer,
    recognizedUserIds?: string[] | null,
  ): ProposalsResult;
  processCommit(commit: Buffer): void;
  processWelcome(welcome: Buffer): void;
  setPassthroughMode(passthroughMode: boolean, transitionExpiry?: number | null): void;
  encryptOpus(packet: Buffer): Buffer;
  decrypt(userId: string, mediaType: MediaType, packet: Buffer): Buffer;
  canPassthrough(userId: string): boolean;
  getUserIds(): string[];
}

export type DaveSessionFactory = (protocolVersion: number, userId: string, channelId: string) => DaveSessionLike;

export class DaveSessionManager {
  private readonly pendingTransitions = new Map<number, number>();
  private readonly recognizedUserIds = new Set<string>();
  private protocolVersion = 0;
  private downgraded = false;
  private session: DaveSessionLike | null = null;

  constructor(
    private readonly userId: string,
    private readonly channelId: string,
    private readonly sessionFactory: DaveSessionFactory = (protocolVersion, nextUserId, nextChannelId) =>
      new DAVESession(protocolVersion, nextUserId, nextChannelId),
  ) {}

  get maxProtocolVersion(): number {
    return DAVE_PROTOCOL_VERSION;
  }

  get currentProtocolVersion(): number {
    return this.protocolVersion;
  }

  get ready(): boolean {
    return this.protocolVersion !== 0 && Boolean(this.session?.ready);
  }

  get currentVoicePrivacyCode(): string {
    return this.session?.voicePrivacyCode ?? "";
  }

  getCurrentUserIds(): string[] {
    return this.session?.getUserIds() ?? [];
  }

  setRecognizedUserIds(userIds: string[]): void {
    this.recognizedUserIds.clear();
    for (const userId of userIds) {
      this.recognizedUserIds.add(userId);
    }
  }

  addRecognizedUsers(userIds: string[]): void {
    for (const userId of userIds) {
      this.recognizedUserIds.add(userId);
    }
  }

  removeRecognizedUsers(userIds: string[]): void {
    for (const userId of userIds) {
      this.recognizedUserIds.delete(userId);
    }
  }

  getIdentifyData(): Record<string, number> {
    return {
      max_dave_protocol_version: this.maxProtocolVersion,
    };
  }

  handleSessionDescription(protocolVersion: number): DaveGatewayAction[] {
    this.protocolVersion = protocolVersion;
    const actions = this.reinitializeSession();
    actions.unshift(this.log("debug", `DAVE session description received (v${protocolVersion})`));
    return actions;
  }

  handlePrepareEpoch(payload: DavePrepareEpochPayload): DaveGatewayAction[] {
    const actions: DaveGatewayAction[] = [
      this.log("debug", `Preparing for DAVE epoch (${payload.epoch})`),
    ];
    if (payload.epoch === 1) {
      this.protocolVersion = payload.protocol_version;
      actions.push(...this.reinitializeSession());
    }
    return actions;
  }

  handlePrepareTransition(payload: DavePrepareTransitionPayload): DaveGatewayAction[] {
    const actions: DaveGatewayAction[] = [
      this.log("debug", `Preparing for DAVE transition (${payload.transition_id}, v${payload.protocol_version})`),
    ];
    this.pendingTransitions.set(payload.transition_id, payload.protocol_version);

    if (payload.transition_id === 0) {
      actions.push(...this.executePendingTransition(payload.transition_id));
      return actions;
    }

    if (payload.protocol_version === 0) {
      this.session?.setPassthroughMode(true, 120);
    }

    actions.push(this.sendJson(VoiceOpcode.DAVE_TRANSITION_READY, { transition_id: payload.transition_id }));
    return actions;
  }

  handleExecuteTransition(payload: DaveExecuteTransitionPayload): DaveGatewayAction[] {
    return [
      this.log("debug", `Executing DAVE transition (${payload.transition_id})`),
      ...this.executePendingTransition(payload.transition_id),
    ];
  }

  handleBinaryMessage(message: Buffer): DaveGatewayAction[] {
    if (message.length < 3) {
      return [this.log("warn", "Received an undersized DAVE binary packet.")];
    }

    const opcode = message.readUInt8(2);
    switch (opcode) {
      case VoiceOpcode.MLS_EXTERNAL_SENDER:
        return this.handleMlsExternalSender(message.subarray(3));
      case VoiceOpcode.MLS_PROPOSALS:
        return this.handleMlsProposals(message);
      case VoiceOpcode.MLS_ANNOUNCE_COMMIT_TRANSITION:
        return this.handleMlsCommitTransition(message);
      case VoiceOpcode.MLS_WELCOME:
        return this.handleMlsWelcome(message);
      default:
        return [this.log("debug", `Ignoring unsupported DAVE binary opcode ${opcode}.`)];
    }
  }

  encryptOpus(packet: Buffer): Buffer {
    if (!this.ready || packet.length === 0) {
      return packet;
    }
    return this.session!.encryptOpus(packet);
  }

  decryptOpus(userId: string, packet: Buffer): Buffer {
    if (!this.session || packet.length === 0) {
      return packet;
    }

    const canDecrypt = this.ready || (this.session.ready && this.session.canPassthrough(userId));
    if (!canDecrypt) {
      return packet;
    }

    return this.session.decrypt(userId, MediaType.AUDIO, packet);
  }

  private handleMlsExternalSender(payload: Buffer): DaveGatewayAction[] {
    if (!this.session) {
      return [this.log("warn", "Received MLS external sender before the DAVE session was initialized.")];
    }

    this.session.setExternalSender(payload);
    return [this.log("debug", "Stored MLS external sender for the DAVE session.")];
  }

  private handleMlsProposals(message: Buffer): DaveGatewayAction[] {
    if (!this.session) {
      return [this.log("warn", "Received MLS proposals before the DAVE session was initialized.")];
    }

    const operationType = message.readUInt8(3) as ProposalsOperationType;
    const proposals = message.subarray(4);
    let commit: Buffer | undefined;
    let welcome: Buffer | undefined;
    try {
      ({ commit, welcome } = this.session.processProposals(
        operationType,
        proposals,
        [...this.recognizedUserIds],
      ));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!errorMessage.includes("UnexpectedUser(")) {
        return [this.log("warn", `MLS proposals errored: ${errorMessage}`)];
      }

      const unexpectedUserId = errorMessage.match(/UnexpectedUser\(([^)]+)\)/)?.[1];
      if (unexpectedUserId) {
        this.recognizedUserIds.add(unexpectedUserId);
      }

      try {
        ({ commit, welcome } = this.session.processProposals(
          operationType,
          proposals,
          null,
        ));
      } catch (retryError) {
        return [
          this.log(
            "warn",
            `MLS proposals retry errored after unexpected user recovery: ${retryError instanceof Error ? retryError.message : String(retryError)}`,
          ),
        ];
      }
    }

    const actions: DaveGatewayAction[] = [
      this.log("debug", `Processed MLS proposals (${operationType === ProposalsOperationType.APPEND ? "append" : "revoke"}).`),
    ];
    if (commit) {
      actions.push(this.sendBinary(
        VoiceOpcode.MLS_COMMIT_WELCOME,
        welcome ? Buffer.concat([commit, welcome]) : commit,
      ));
    }
    return actions;
  }

  private handleMlsCommitTransition(message: Buffer): DaveGatewayAction[] {
    return this.handleCommitLikeMessage(
      message,
      "commit",
      (payload) => {
        this.session!.processCommit(payload);
      },
    );
  }

  private handleMlsWelcome(message: Buffer): DaveGatewayAction[] {
    return this.handleCommitLikeMessage(
      message,
      "welcome",
      (payload) => {
        this.session!.processWelcome(payload);
      },
    );
  }

  private handleCommitLikeMessage(
    message: Buffer,
    label: "commit" | "welcome",
    processor: (payload: Buffer) => void,
  ): DaveGatewayAction[] {
    if (!this.session) {
      return [this.log("warn", `Received MLS ${label} before the DAVE session was initialized.`)];
    }

    const transitionId = message.readUInt16BE(3);
    try {
      processor(message.subarray(5));
      const actions: DaveGatewayAction[] = [
        this.log("debug", `MLS ${label} processed (transition id: ${transitionId})`),
      ];
      if (transitionId !== 0) {
        this.pendingTransitions.set(transitionId, this.protocolVersion);
        actions.push(this.sendJson(VoiceOpcode.DAVE_TRANSITION_READY, { transition_id: transitionId }));
      }
      return actions;
    } catch (error) {
      return [
        this.log("warn", `MLS ${label} errored: ${error instanceof Error ? error.message : String(error)}`),
        this.sendJson(VoiceOpcode.MLS_INVALID_COMMIT_WELCOME, { transition_id: transitionId }),
        ...this.reinitializeSession(),
      ];
    }
  }

  private executePendingTransition(transitionId: number): DaveGatewayAction[] {
    const protocolVersion = this.pendingTransitions.get(transitionId);
    if (protocolVersion === undefined) {
      return [this.log("warn", `Received execute transition, but no pending transition exists for ${transitionId}.`)];
    }

    const oldVersion = this.protocolVersion;
    this.protocolVersion = protocolVersion;
    const actions: DaveGatewayAction[] = [];

    if (oldVersion !== this.protocolVersion && this.protocolVersion === 0) {
      this.downgraded = true;
      actions.push(this.log("debug", "DAVE protocol downgraded."));
    } else if (transitionId > 0 && this.downgraded) {
      this.downgraded = false;
      this.session?.setPassthroughMode(true, 10);
      actions.push(this.log("debug", "DAVE protocol upgraded."));
    }

    actions.push(this.log("debug", `DAVE transition executed (v${oldVersion} -> v${this.protocolVersion}, id: ${transitionId})`));
    this.pendingTransitions.delete(transitionId);
    return actions;
  }

  private reinitializeSession(): DaveGatewayAction[] {
    if (this.protocolVersion > 0) {
      if (this.session) {
        this.session.reinit(this.protocolVersion, this.userId, this.channelId);
      } else {
        this.session = this.sessionFactory(this.protocolVersion, this.userId, this.channelId);
      }

      return [
        this.log("debug", `DAVE session initialized for protocol version ${this.protocolVersion}`),
        this.sendBinary(VoiceOpcode.MLS_KEY_PACKAGE, this.session.getSerializedKeyPackage()),
      ];
    }

    this.session?.reset();
    if (this.session) {
      this.session.setPassthroughMode(true, 10);
    }
    return [this.log("debug", "DAVE session reset.")];
  }

  private sendJson(op: VoiceOpcode, data: Record<string, unknown>): DaveGatewayAction {
    return {
      kind: "send-json",
      op,
      data,
    };
  }

  private sendBinary(op: VoiceOpcode, body: Buffer): DaveGatewayAction {
    return {
      kind: "send-binary",
      op,
      body,
    };
  }

  private log(level: "debug" | "warn", message: string): DaveGatewayAction {
    return {
      kind: "log",
      level,
      message,
    };
  }
}
