import test from "node:test";
import assert from "node:assert/strict";
import { buildHelpPages, collectHelpEntries } from "../../src/commands/meta.js";

function createBotMock() {
  return {
    config: { prefix: "!" },
    commands: new Map([
      ["help", { name: "help", description: "List bot commands.", cog: "manager" }],
      ["h", { name: "help", description: "List bot commands.", cog: "manager" }],
      ["about", { name: "about", description: "Show bot info.", cog: "utility", ownerOnly: true }],
      ["avatar", { name: "avatar", description: "Show a user avatar.", cog: "utility" }],
      ["ping", { name: "ping", description: "Check bot latency.", cog: "utility" }],
      ["play", { name: "play", description: "Queue music.", cog: "music", aliases: ["p"], guildOnly: true }],
      ["skip", { name: "skip", description: "Skip the current track.", cog: "music" }],
      ["pause", { name: "pause", description: "Pause playback.", cog: "music" }],
      ["resume", { name: "resume", description: "Resume playback.", cog: "music" }],
      ["queue", { name: "queue", description: "Show the queue.", cog: "music" }],
      ["np", { name: "np", description: "Show now playing.", cog: "music" }],
      ["stop", { name: "stop", description: "Stop playback.", cog: "music" }],
      ["clear", { name: "clear", description: "Clear the queue.", cog: "music" }],
      ["shuffle", { name: "shuffle", description: "Shuffle the queue.", cog: "music" }],
    ]),
  };
}

test("collectHelpEntries deduplicates aliases by command name", () => {
  const entries = collectHelpEntries(createBotMock() as never);

  assert.equal(entries.filter((entry) => entry.name === "help").length, 1);
  assert.equal(entries.length, 13);
});

test("buildHelpPages chunks commands into multiple pages", () => {
  const pages = buildHelpPages(createBotMock() as never);
  const overviewPage = pages[0]?.data;
  const managerPage = pages[1]?.data;
  const firstMusicPage = pages[2]?.data;
  const secondMusicPage = pages[3]?.data;
  const utilityPage = pages[4]?.data;

  assert.equal(pages.length, 5);
  assert.equal(overviewPage?.title, "Help");
  assert.match(overviewPage?.description ?? "", /13 command\(s\) available across 3 categories\./);
  assert.deepEqual(
    overviewPage?.fields?.map((field) => field.name),
    ["Manager (1)", "Music (9)", "Utility (3)"],
  );
  assert.match(overviewPage?.footer?.text ?? "", /Prefix: ! \| Page 1\/5/);

  assert.equal(managerPage?.title, "Help: Manager");
  assert.equal(managerPage?.fields?.[0]?.name, "!help");
  assert.match(managerPage?.fields?.[0]?.value ?? "", /List bot commands\./);

  assert.equal(firstMusicPage?.title, "Help: Music 1/2");
  assert.equal(firstMusicPage?.fields?.some((field) => field.name === "!play"), true);
  assert.match(
    firstMusicPage?.fields?.find((field) => field.name === "!play")?.value ?? "",
    /Aliases: `!p`/,
  );
  assert.match(
    firstMusicPage?.fields?.find((field) => field.name === "!play")?.value ?? "",
    /Access: server only/,
  );
  assert.match(firstMusicPage?.footer?.text ?? "", /Prefix: ! \| Page 3\/5/);

  assert.equal(secondMusicPage?.title, "Help: Music 2/2");
  assert.equal(secondMusicPage?.fields?.some((field) => field.name === "!stop"), true);
  assert.match(secondMusicPage?.footer?.text ?? "", /Prefix: ! \| Page 4\/5/);

  assert.equal(utilityPage?.title, "Help: Utility");
  assert.match(utilityPage?.fields?.find((field) => field.name === "!about")?.value ?? "", /Access: owner only/);
  assert.match(utilityPage?.footer?.text ?? "", /Prefix: ! \| Page 5\/5/);
});
