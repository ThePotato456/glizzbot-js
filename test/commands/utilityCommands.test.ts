import test from "node:test";
import assert from "node:assert/strict";
import { createUtilityCommands } from "../../src/commands/utility.js";
import type { CommandContext } from "../../src/types.js";

function createCommandContext() {
  const replies: string[] = [];
  const ctx: CommandContext = {
    message: {
      reply: async (content: string) => {
        replies.push(content);
        return {} as never;
      },
    } as never,
    args: [],
    rawArgs: "",
    guild: null,
    member: null,
    channel: {} as never,
    reply: async (content: string) => {
      replies.push(content);
      return {} as never;
    },
  };

  return { ctx, replies };
}

test("about reports git commit metadata", async () => {
  const bot = {
    runtimeVersion: {
      gitCommit: "1efb160abc1234567890",
      gitCommitShort: "1efb160",
      gitBranch: "main",
      displayVersion: "1efb160",
    },
    guilds: {
      cache: {
        size: 3,
      },
    },
  };

  const about = createUtilityCommands(bot as never).find((command) => command.name === "about");
  assert.ok(about);

  const { ctx, replies } = createCommandContext();
  await about.execute(ctx);

  assert.equal(replies.length, 1);
  assert.match(replies[0] ?? "", /GlizzBot 1efb160/);
  assert.match(replies[0] ?? "", /Commit: 1efb160abc1234567890/);
  assert.match(replies[0] ?? "", /Branch: main/);
  assert.match(replies[0] ?? "", /Guilds: 3/);
});
