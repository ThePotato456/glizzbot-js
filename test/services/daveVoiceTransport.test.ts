import test from "node:test";
import assert from "node:assert/strict";
import { planPlaybackDispatch } from "../../src/services/voice/daveVoiceTransport.js";

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
