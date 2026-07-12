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
  parseDaveBinaryPacket,
  type DaveBinaryPacket,
  type DaveExecuteTransitionPayload,
  type DaveGatewayAction,
  type DavePrepareEpochPayload,
  type DavePrepareTransitionPayload,
} from "./daveProtocol.js";

interface DaveSessionLike {
  readonly ready: boolean;
  readonly status: SessionStatus;
  readonly voicePrivacyCode: string;
  readonly epoch?: bigint | null;
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
  private readonly pendingMediaTransitions = new Set<number>();
  private readonly recognizedUserIds = new Set<string>();
  private protocolVersion = 0;
  private downgraded = false;
  private session: DaveSessionLike | null = null;

  constructor(
    private readonly userId: string,
    private readonly channelId: string,
    private readonly sessionFactory: DaveSessionFactory = (protocolVersion, nextUserId, nextChannelId) =>
      new DAVESession(protocolVersion, nextUserId, nextChannelId),
    private readonly isKnownVoiceUser: (userId: string) => boolean = () => false,
  ) {}

  get maxProtocolVersion(): number {
    return DAVE_PROTOCOL_VERSION;
  }

  get currentProtocolVersion(): number {
    return this.protocolVersion;
  }

  get ready(): boolean {
    return this.protocolVersion !== 0
      && this.pendingMediaTransitions.size === 0
      && Boolean(this.session?.ready);
  }

  get currentVoicePrivacyCode(): string {
    return this.session?.voicePrivacyCode ?? "";
  }

  get currentSessionStatus(): SessionStatus | null {
    return this.session?.status ?? null;
  }

  get currentEpoch(): string | null {
    return this.session?.epoch?.toString() ?? null;
  }

  get pendingTransitionCount(): number {
    return this.pendingTransitions.size;
  }

  get recognizedUserCount(): number {
    return this.recognizedUserIds.size;
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
    if (!Number.isSafeInteger(protocolVersion) || protocolVersion < 0 || protocolVersion > this.maxProtocolVersion) {
      return [this.log("warn", `Ignoring unsupported DAVE session protocol version ${protocolVersion}.`)];
    }
    this.pendingTransitions.clear();
    this.pendingMediaTransitions.clear();
    this.downgraded = false;
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
      try {
        this.session?.setPassthroughMode(true, 120);
      } catch (error) {
        actions.push(this.operationError("enable-downgrade-passthrough", error, payload.transition_id));
        return actions;
      }
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
    const parsed = parseDaveBinaryPacket(message);
    if (!parsed.ok) {
      return [this.log("warn", parsed.error)];
    }

    switch (parsed.value.kind) {
      case "external-sender":
        return this.handleMlsExternalSender(parsed.value.payload);
      case "proposals":
        return this.handleMlsProposals(parsed.value);
      case "commit":
        return this.handleMlsCommitTransition(parsed.value);
      case "welcome":
        return this.handleMlsWelcome(parsed.value);
      default:
        return [this.log("debug", `Ignoring unsupported DAVE binary opcode ${parsed.value.opcode}.`)];
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

    try {
      this.session.setExternalSender(payload);
      return [this.log("debug", "Stored MLS external sender for the DAVE session.")];
    } catch (error) {
      return [this.operationError("set-external-sender", error)];
    }
  }

  private handleMlsProposals(packet: Extract<DaveBinaryPacket, { kind: "proposals" }>): DaveGatewayAction[] {
    if (!this.session) {
      return [this.log("warn", "Received MLS proposals before the DAVE session was initialized.")];
    }

    const operationType = packet.operationType as ProposalsOperationType;
    const proposals = packet.payload;
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
      if (!unexpectedUserId || !/^\d+$/.test(unexpectedUserId) || !this.isKnownVoiceUser(unexpectedUserId)) {
        return [this.log(
          "warn",
          `MLS proposals rejected an unrecognized voice user: ${unexpectedUserId ?? "unknown"}.`,
          "dave-participant-validation-failed",
          `userId:${unexpectedUserId ?? "unknown"}`,
        )];
      }
      this.recognizedUserIds.add(unexpectedUserId);

      try {
        ({ commit, welcome } = this.session.processProposals(
          operationType,
          proposals,
          [...this.recognizedUserIds],
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

  private handleMlsCommitTransition(
    packet: Extract<DaveBinaryPacket, { kind: "commit" | "welcome" }>,
  ): DaveGatewayAction[] {
    return this.handleCommitLikeMessage(
      packet.transitionId,
      packet.payload,
      "commit",
      (payload) => {
        this.session!.processCommit(payload);
      },
    );
  }

  private handleMlsWelcome(
    packet: Extract<DaveBinaryPacket, { kind: "commit" | "welcome" }>,
  ): DaveGatewayAction[] {
    return this.handleCommitLikeMessage(
      packet.transitionId,
      packet.payload,
      "welcome",
      (payload) => {
        this.session!.processWelcome(payload);
      },
    );
  }

  private handleCommitLikeMessage(
    transitionId: number,
    payload: Buffer,
    label: "commit" | "welcome",
    processor: (payload: Buffer) => void,
  ): DaveGatewayAction[] {
    if (!this.session) {
      return [this.log("warn", `Received MLS ${label} before the DAVE session was initialized.`)];
    }

    try {
      processor(payload);
      const actions: DaveGatewayAction[] = [
        this.log("debug", `MLS ${label} processed (transition id: ${transitionId})`),
      ];
      if (transitionId !== 0) {
        this.pendingTransitions.set(transitionId, this.protocolVersion);
        this.pendingMediaTransitions.add(transitionId);
        actions.push(this.sendJson(VoiceOpcode.DAVE_TRANSITION_READY, { transition_id: transitionId }));
      }
      return actions;
    } catch (error) {
      return [
        this.log(
          "warn",
          `MLS ${label} errored: ${error instanceof Error ? error.message : String(error)}`,
          "dave-mls-resync",
          `transitionId:${transitionId},messageType:${label}`,
        ),
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
      try {
        this.session?.setPassthroughMode(true, 10);
      } catch (error) {
        actions.push(this.operationError("enable-upgrade-passthrough", error, transitionId));
      }
      actions.push(this.log("debug", "DAVE protocol upgraded."));
    }

    actions.push(this.log("debug", `DAVE transition executed (v${oldVersion} -> v${this.protocolVersion}, id: ${transitionId})`));
    this.pendingTransitions.delete(transitionId);
    this.pendingMediaTransitions.delete(transitionId);
    return actions;
  }

  private reinitializeSession(): DaveGatewayAction[] {
    if (this.protocolVersion > 0) {
      try {
        if (this.session) {
          this.session.reinit(this.protocolVersion, this.userId, this.channelId);
        } else {
          this.session = this.sessionFactory(this.protocolVersion, this.userId, this.channelId);
        }

        return [
          this.log("debug", `DAVE session initialized for protocol version ${this.protocolVersion}`),
          this.sendBinary(VoiceOpcode.MLS_KEY_PACKAGE, this.session.getSerializedKeyPackage()),
        ];
      } catch (error) {
        return [this.operationError("initialize-session-or-key-package", error)];
      }
    }

    try {
      this.session?.reset();
      if (this.session) {
        this.session.setPassthroughMode(true, 10);
      }
      return [this.log("debug", "DAVE session reset.")];
    } catch (error) {
      return [this.operationError("reset-session", error)];
    }
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

  private log(level: "debug" | "warn", message: string, event?: string, extra?: string): DaveGatewayAction {
    return {
      kind: "log",
      level,
      message,
      ...(event === undefined ? {} : { event }),
      ...(extra === undefined ? {} : { extra }),
    };
  }

  private operationError(operation: string, error: unknown, transitionId?: number): DaveGatewayAction {
    return {
      kind: "failure",
      operation,
      message: error instanceof Error ? error.message : String(error),
      protocolVersion: this.protocolVersion,
      ...(transitionId === undefined ? {} : { transitionId }),
    };
  }
}
