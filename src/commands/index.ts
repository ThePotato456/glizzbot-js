import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";
import { createHelpCommand } from "./meta.js";
import { createManagerCommands } from "./manager.js";
import { createMusicCommands } from "./music.js";
import { createUtilityCommands } from "./utility.js";
import { createEventCommands } from "./events.js";
import { createSoundCommands } from "./sound.js";
import { createRecordCommands } from "./record.js";
import { createChatCommands } from "./chat.js";
import { createYtdlpCommands } from "./ytdlp.js";
import { createWebCommands } from "./web.js";

export function buildCommands(bot: GlizzBot): BotCommand[] {
  return [
    createHelpCommand(bot),
    ...createManagerCommands(bot),
    ...createMusicCommands(bot),
    ...createUtilityCommands(bot),
    ...createEventCommands(bot),
    ...createSoundCommands(bot),
    ...createRecordCommands(),
    ...createChatCommands(bot),
    ...createYtdlpCommands(),
    ...createWebCommands(bot),
  ];
}
