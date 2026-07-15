# DAVE Implementation Rework Plan

## Objective

Harden the bot's Discord Audio and Video End-to-End Encryption (DAVE) implementation while continuing to use `@snazzah/davey` as the MLS and media-cryptography engine. The bot will remain responsible for Voice Gateway protocol handling, transition orchestration, playback gating, diagnostics, and transport recovery.

The rework must preserve queue and current-track state during recoverable voice failures, reject malformed gateway input safely, maintain participant validation, and comply with Discord Voice Gateway v8 and DAVE frame requirements.

## Progress Tracker

- [x] Audit the existing DAVE session manager, voice transport integration, recovery path, and tests.
- [x] Step 1: Establish DAVE protocol constants, payload types, and validation helpers.
- [x] Step 2: Harden inbound DAVE binary packet parsing.
- [x] Step 3: Add safe boundaries around Davey operations.
- [x] Step 4: Preserve recognized-user validation during proposal recovery.
- [x] Step 5: Correct DAVE encryption of Opus silence frames.
- [x] Step 6: Send the Speaking payload before the first audio packet.
- [x] Step 7: Make Voice Gateway v8 resume sequence-aware.
- [x] Step 8: Reconcile DAVE state after resumed and fresh voice sessions.
- [x] Step 9: Expand DAVE diagnostics and failure classification.
- [x] Step 10: Build comprehensive unit and transport-integration tests.
- [ ] Step 11: Run regression, coverage, and live staging verification.
- [ ] Step 12: Update documentation and commit the completed rework.

## Step-by-Step Plan

### Step 1: Establish Protocol Types and Validation Helpers

- [x] Define opcode-specific inbound payload types in `src/services/voice/daveProtocol.ts`.
- [x] Define minimum binary packet lengths for external sender, proposals, commit transition, and welcome messages.
- [x] Add helpers for reading the server sequence number, opcode, transition ID, operation type, and payload without unchecked buffer access.
- [x] Validate JSON transition payloads before passing them to `DaveSessionManager`.
- [x] Reject unsupported protocol versions above the locally supported Davey version.
- [x] Return structured validation results so malformed input can be logged without throwing.

Acceptance criteria:

- [x] No DAVE handler performs `readUInt*` operations before validating the required buffer length.
- [x] Invalid JSON and binary payloads produce a warning action and do not mutate DAVE state.

### Step 2: Harden Inbound Binary Packet Parsing

- [x] Replace the generic three-byte length check with opcode-specific validation.
- [x] Require at least four bytes before reading the proposals operation type.
- [x] Require at least five bytes before reading commit or welcome transition IDs.
- [x] Reject empty external-sender, proposals, commit, and welcome payloads where the protocol requires data.
- [x] Treat unsupported binary opcodes as debug diagnostics rather than errors.
- [x] Ensure `lastGatewaySequence` is updated only after a valid server binary header is present.

Acceptance criteria:

- [x] Truncated packets of every length from zero through the opcode minimum cannot throw.
- [x] Malformed packets do not call Davey methods or send gateway responses.

### Step 3: Add Safe Davey Operation Boundaries

- [x] Wrap `setExternalSender`, `reinit`, `reset`, `getSerializedKeyPackage`, `processProposals`, `processCommit`, `processWelcome`, and `encryptOpus` in explicit error handling.
- [x] Convert expected Davey failures into typed results or gateway actions instead of allowing native exceptions to escape WebSocket or scheduler callbacks.
- [x] On invalid commit or welcome, send opcode 31, reset the local MLS state, generate a fresh one-time key package, and keep playback paused until readiness returns.
- [x] On external-sender or key-package initialization failure, mark DAVE unavailable for playback and begin bounded recovery or fatal teardown according to connection state.
- [x] Route media-encryption failures through `onPlaybackError` with the active playback ID, then stop or advance playback exactly once.

Acceptance criteria:

- [x] No exception from `@snazzah/davey` can escape a WebSocket event callback or playback scheduler tick.
- [x] Every Davey failure records the operation, protocol version, transition ID when available, and recovery decision.

### Step 4: Preserve Recognized-User Validation

- [x] Replace the proposals retry using `recognizedUserIds = null` with a retry using the updated recognized-user set.
- [x] Parse and validate the `UnexpectedUser(...)` identifier before adding it to the recognized set.
- [x] Confirm the unexpected user is present in the current voice-channel membership or a recent Clients Connect event before trusting it.
- [x] If membership cannot be confirmed, reject the proposals and wait for authenticated Clients Connect or channel-membership state before retrying.
- [x] Support all user IDs supplied by Clients Connect payloads, including array-shaped payloads if Discord sends more than one participant.

Acceptance criteria:

- [x] Proposal processing never disables recognized-user validation as a fallback.
- [x] A valid newly connected participant can recover from an ordering race between Clients Connect and MLS proposals.
- [x] An unknown participant cannot be silently admitted to the MLS group.

### Step 5: Encrypt Every DAVE Opus Frame

- [x] Remove the `SILENCE_FRAME` exception from DAVE frame encryption.
- [x] Pass normal audio, underrun silence, and the five terminating silence frames through `DaveSessionManager.encryptOpus()` whenever DAVE is active and ready.
- [x] Continue applying Discord transport encryption after DAVE frame encryption.
- [x] Keep plaintext Opus behavior only when the negotiated DAVE protocol version is zero.
- [x] Pause transmission instead of sending plaintext if DAVE is enabled but not ready.

Acceptance criteria:

- [x] Every Opus frame sent while DAVE protocol version is greater than zero contains Davey-produced DAVE framing.
- [x] No plaintext silence frame is sent during an active DAVE session.
- [x] Protocol version zero continues to send transport-encrypted, non-DAVE Opus frames.

### Step 6: Correct Speaking and First-Packet Ordering

- [x] Introduce a `speakingAnnounced` or equivalent per-session state.
- [x] Send Voice Gateway opcode 5 with `speaking: 1` before transmitting the first UDP audio packet.
- [x] Do not rely on WebSocket and UDP delivery timing to establish the correct order.
- [x] Reset speaking-announcement state after reconnect, new Session Description, SSRC change, stop, and disconnect.
- [x] Preserve the existing `speaking: 0` behavior for pause, underrun, recovery, stop, and teardown.

Acceptance criteria:

- [x] The first outbound audio packet is never sent until an opcode 5 speaking notification has been issued for the current SSRC.
- [x] Resumed playback announces speaking again when required by a fresh voice session.

### Step 7: Make Gateway v8 Resume Sequence-Aware

- [x] Include `seq_ack: lastGatewaySequence` in Voice Gateway opcode 7 Resume payloads.
- [x] Use `-1` or omit `seq_ack` only when no numbered message has ever been received.
- [x] Preserve sequence numbers from both JSON and binary server messages.
- [x] Verify sequence wraparound does not incorrectly reset or compare values locally.
- [x] Add the sequence acknowledgment to recovery diagnostics.

Acceptance criteria:

- [x] Every v8 Resume payload acknowledges the latest valid server sequence.
- [x] Buffered DAVE transition messages can be replayed by Discord after recovery.

### Step 8: Reconcile DAVE State Across Recovery

- [x] On successful opcode 9 Resumed, retain the existing Davey MLS session and wait for any buffered transition messages before resuming source reads.
- [x] Define a short reconciliation point that confirms the transport is connected and DAVE is ready before playback resumes.
- [x] On fallback Ready plus Session Description, treat the connection as a fresh voice negotiation and reinitialize DAVE from the new protocol version.
- [x] Clear stale pending transitions when a fresh Session Description replaces the prior session.
- [x] Reset stale external-sender and participant state when Discord establishes a genuinely new voice session.
- [x] Keep UDP only for a successful resume; recreate it for a fresh Ready flow or UDP failure.

Acceptance criteria:

- [x] Successful resume preserves current playback and MLS state.
- [x] Fresh negotiation cannot reuse stale pending transitions or cryptographic state.
- [x] Playback resumes only when both transport and negotiated DAVE state are ready.

### Step 9: Expand Diagnostics and Failure Classification

- [x] Add diagnostic events for malformed DAVE packets, Davey operation failures, MLS resync requests, participant-validation failures, and DAVE readiness timeouts.
- [x] Include protocol version, Davey session status, epoch when available, transition ID, packet opcode, packet length, and recognized-user count.
- [x] Never log MLS keys, key packages, commits, welcome bodies, external-sender bodies, or encrypted media contents.
- [x] Distinguish recoverable MLS resynchronization from fatal DAVE initialization failure.
- [x] Add DAVE readiness and pending-transition information to `voicecheck` and transport snapshots.

Acceptance criteria:

- [x] A production log can explain why playback paused and whether the bot is waiting, recovering, resynchronizing, or tearing down.
- [x] Diagnostics contain no cryptographic secrets or raw sensitive payloads.

### Step 10: Expand Automated Tests

- [x] Add table-driven tests for every supported and unsupported DAVE binary opcode.
- [x] Test every truncated packet length and assert that no handler throws.
- [x] Test invalid external-sender, key-package, proposals, commit, welcome, and encryption operations using a throwing fake Davey session.
- [x] Test recognized-user retry with an updated validated set and rejection of an unknown user.
- [x] Test protocol downgrade, upgrade, epoch-one initialization, epoch changes, commit transitions, welcomes, and invalid-group resynchronization.
- [x] Test that ordinary and silence Opus frames are both DAVE-encrypted when enabled.
- [x] Test that plaintext frames are used only for protocol version zero.
- [x] Test that Speaking is sent before the first UDP packet.
- [x] Test Resume payloads with normal, absent, and wrapped sequence numbers.
- [x] Test successful resume, buffered transition replay, fresh negotiation fallback, and recovery exhaustion.
- [x] Replace permissive fakes with stateful fakes that model `INACTIVE`, `PENDING`, `AWAITING_RESPONSE`, and `ACTIVE` Davey statuses.

Acceptance criteria:

- [x] Tests assert externally visible state and gateway/UDP actions, not only internal method calls.
- [x] DAVE manager and recovery tests cover success, malformed input, library failure, and race conditions.
- [x] `npm test` and `npm run test:coverage` pass without reducing configured coverage thresholds.

### Step 11: Regression and Staging Verification

- [x] Run `npm run build`.
- [x] Run `npm test`.
- [x] Run `npm run test:coverage`.
- [ ] Perform repeated local connect, play, pause, resume, skip, stop, and disconnect cycles.
- [x] Test participant join and leave events while music is playing.
- [x] Test an abnormal WebSocket close during active DAVE playback and verify sequence-aware resume.
- [ ] Test a forced fresh voice negotiation after resume failure.
- [x] Confirm queue state and current track survive recoverable loss.
- [ ] Confirm unrecoverable DAVE failures produce a labeled teardown and useful snapshot.
- [ ] Review logs for plaintext payload leakage and duplicate playback advancement.

Acceptance criteria:

- [ ] No unexpected voice disconnect occurs during normal playback or participant transitions.
- [ ] Recovery either returns to encrypted playback or performs one clearly labeled fatal teardown.
- [ ] Live diagnostics match the expected state transitions documented by the tests.

### Step 12: Documentation and Commit

- [x] Update this tracker as each step is completed.
- [x] Document the boundary between in-house protocol orchestration and Davey's cryptographic responsibilities.
- [x] Document recovery behavior, fatal conditions, and the meaning of DAVE diagnostics.
- [x] Record the tested Davey package version and Discord Voice Gateway version.
- [x] Review the final diff for unrelated files and generated artifacts.
- [x] Commit the rework in logical commits or one reviewed final commit, as agreed before implementation.

## Recommended Implementation Order

1. Complete Steps 1 through 4 first because they make gateway input and MLS state handling safe.
2. Complete Steps 5 and 6 together because both change outbound media behavior.
3. Complete Steps 7 and 8 together because sequence acknowledgment and DAVE reconciliation are one recovery path.
4. Add diagnostics alongside each behavior change rather than after all implementation is finished.
5. Add or update tests in the same change as each production fix.
6. Finish with the complete regression and staging matrix before marking the rework complete.

## Scope Boundaries

- This plan keeps `@snazzah/davey` as the cryptographic implementation.
- This plan does not implement MLS or DAVE cryptography from scratch.
- This plan does not add inbound audio recording or receive-side media processing beyond what is needed for DAVE state correctness.
- This plan does not change queue policy, resolver behavior, or ffmpeg retry behavior.
- Dependency upgrades should be handled separately unless a Davey defect blocks one of the required fixes.

## Tested Versions

- Discord Voice Gateway: version 8 (`?v=8&encoding=json`).
- DAVE protocol: highest version exported by `@snazzah/davey` and advertised through `max_dave_protocol_version`.
- Davey package: `@snazzah/davey` version `0.1.12`.

## Current Verification

- TypeScript build: passing.
- Automated tests: 115 passing.
- Coverage: 82.16% lines, 77.61% branches, and 83.71% functions on the latest coverage run before the final test-only additions.
- Live staging confirmed participant transitions and an active-playback `1006` Resume with the current playback ID preserved.
- A `4022` call termination exposed invalid repeated Resume attempts; `4022` now tears down immediately and `4006`/`4009` switch recovery to Identify. Live verification of that fresh negotiation remains pending.
