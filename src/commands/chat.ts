import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

export function createChatCommands(bot: GlizzBot): BotCommand[] {
  return [
    {
      name: "chat",
      cog: "chat",
      description: "Send a prompt to the local chat backend.",
      guildOnly: true,
      async execute(ctx) {
        if (!ctx.rawArgs) {
          await ctx.reply("Usage: chat <prompt>");
          return;
        }
        const response = await bot.chat.chat(ctx.guild!.id, ctx.rawArgs);
        await ctx.reply(response);
      },
    },
    {
      name: "reset",
      cog: "chat",
      description: "Reset the current conversation.",
      guildOnly: true,
      async execute(ctx) {
        bot.chat.reset(ctx.guild!.id);
        await ctx.reply("Conversation reset.");
      },
    },
    {
      name: "convo",
      cog: "chat",
      description: "Show the stored conversation.",
      guildOnly: true,
      async execute(ctx) {
        bot.chat.ensure(ctx.guild!.id);
        const convo = bot.chat.getConversation(ctx.guild!.id);
        await ctx.reply(convo.map((message) => `${message.role}: ${message.content}`).join("\n"));
      },
    },
    {
      name: "changepersona",
      cog: "chat",
      description: "Set a new persona/system prompt.",
      guildOnly: true,
      async execute(ctx) {
        if (!ctx.rawArgs) {
          await ctx.reply("Usage: changepersona <system prompt>");
          return;
        }
        bot.chat.setPersona(ctx.guild!.id, ctx.rawArgs);
        await ctx.reply("Persona updated and conversation reset.");
      },
    },
    {
      name: "tokens",
      cog: "chat",
      description: "Estimate token count for the current conversation.",
      guildOnly: true,
      async execute(ctx) {
        const chars = bot.chat.getConversation(ctx.guild!.id).reduce((sum, item) => sum + item.content.length, 0);
        await ctx.reply(`Approx tokens: ${Math.ceil(chars / 4)}`);
      },
    },
  ];
}
