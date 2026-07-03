import { performance } from "node:perf_hooks";
import { parentPort } from "node:worker_threads";

interface ScheduleMessage {
  type: "schedule";
  scheduledAt: number;
}

interface StopMessage {
  type: "stop";
}

type WorkerMessage = ScheduleMessage | StopMessage;

const sleepBuffer = new SharedArrayBuffer(4);
const sleepSignal = new Int32Array(sleepBuffer);

function sleepFor(milliseconds: number): void {
  if (milliseconds <= 0) {
    return;
  }

  Atomics.wait(sleepSignal, 0, 0, milliseconds);
}

function isWorkerMessage(message: unknown): message is WorkerMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<WorkerMessage>;
  if (candidate.type === "stop") {
    return true;
  }

  return candidate.type === "schedule" && typeof candidate.scheduledAt === "number";
}

parentPort?.on("message", (message: unknown) => {
  if (!isWorkerMessage(message)) {
    return;
  }

  if (message.type === "stop") {
    process.exit(0);
  }

  while (true) {
    const remainingMs = message.scheduledAt - performance.now();
    if (remainingMs <= 0.75) {
      break;
    }

    sleepFor(Math.max(1, Math.min(remainingMs - 0.25, 10)));
  }

  parentPort?.postMessage({
    type: "tick",
    scheduledAt: message.scheduledAt,
  });
});
