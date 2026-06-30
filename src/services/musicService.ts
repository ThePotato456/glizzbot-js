import crypto from "node:crypto";
import type { MusicState, QueueItem } from "../types.js";
import { formatDuration } from "../utils/format.js";

export class MusicService {
  private readonly states = new Map<string, MusicState>();

  constructor(
    private readonly idleDisconnectMs: number,
    private readonly defaultShouldLeave: boolean,
    private readonly defaultTimingDebug: boolean,
  ) {}

  getState(guildId: string): MusicState {
    let state = this.states.get(guildId);
    if (!state) {
      state = {
        guildId,
        queue: [],
        current: null,
        isPaused: false,
        shouldLeave: this.defaultShouldLeave,
        timingDebug: this.defaultTimingDebug,
        startedAt: null,
        lastStopReason: null,
        incidentMarks: [],
      };
      this.states.set(guildId, state);
    }
    return state;
  }

  enqueue(guildId: string, item: Omit<QueueItem, "id" | "addedAt">): QueueItem {
    const state = this.getState(guildId);
    const queueItem: QueueItem = {
      ...item,
      id: crypto.randomUUID(),
      addedAt: Date.now(),
    };
    state.queue.push(queueItem);
    return queueItem;
  }

  startNext(guildId: string): QueueItem | null {
    const state = this.getState(guildId);
    const next = state.queue.shift() ?? null;
    state.current = next;
    state.startedAt = next ? Date.now() : null;
    state.isPaused = false;
    return next;
  }

  skip(guildId: string, reason: string): QueueItem | null {
    const state = this.getState(guildId);
    state.lastStopReason = reason;
    state.current = null;
    state.startedAt = null;
    state.isPaused = false;
    return this.startNext(guildId);
  }

  stop(guildId: string, reason: string): void {
    const state = this.getState(guildId);
    state.lastStopReason = reason;
    state.current = null;
    state.queue = [];
    state.startedAt = null;
    state.isPaused = false;
  }

  clear(guildId: string): number {
    const state = this.getState(guildId);
    const cleared = state.queue.length;
    state.queue = [];
    return cleared;
  }

  shuffle(guildId: string): void {
    const state = this.getState(guildId);
    for (let i = state.queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
    }
  }

  remove(guildId: string, index: number): QueueItem | null {
    const state = this.getState(guildId);
    if (index < 0 || index >= state.queue.length) {
      return null;
    }
    const [removed] = state.queue.splice(index, 1);
    return removed ?? null;
  }

  insert(guildId: string, index: number, item: Omit<QueueItem, "id" | "addedAt">): QueueItem {
    const state = this.getState(guildId);
    const queueItem: QueueItem = {
      ...item,
      id: crypto.randomUUID(),
      addedAt: Date.now(),
    };
    state.queue.splice(Math.max(0, index), 0, queueItem);
    return queueItem;
  }

  mark(guildId: string, note: string): void {
    this.getState(guildId).incidentMarks.push({ at: Date.now(), note });
  }

  describeNowPlaying(guildId: string): string {
    const state = this.getState(guildId);
    if (!state.current) {
      return "Nothing is playing right now.";
    }
    const elapsedSeconds = state.startedAt ? Math.floor((Date.now() - state.startedAt) / 1000) : 0;
    return `Now playing: **${state.current.title}** (${formatDuration(elapsedSeconds)} / ${formatDuration(state.current.durationSeconds)})`;
  }

  queueSummary(guildId: string): string {
    const state = this.getState(guildId);
    if (!state.current && state.queue.length === 0) {
      return "Queue is empty.";
    }

    const lines: string[] = [];
    if (state.current) {
      lines.push(`Current: ${state.current.title}`);
    }
    for (const [index, item] of state.queue.entries()) {
      lines.push(`${index + 1}. ${item.title}`);
    }
    return lines.join("\n");
  }

  exportState(): MusicState[] {
    return [...this.states.values()].map((state) => ({ ...state, queue: [...state.queue] }));
  }

  getIdleDisconnectMs(): number {
    return this.idleDisconnectMs;
  }
}
