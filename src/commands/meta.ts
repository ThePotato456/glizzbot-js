import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
} from "discord.js";
import type { BotCommand } from "../types.js";
import type { GlizzBot } from "../bot.js";

const HELP_PAGE_SIZE = 6;
const HELP_TIMEOUT_MS = 2 * 60 * 1000;
const HELP_EMBED_COLOR = 0x2f80ed;

interface HelpEntry {
  name: string;
  description: string;
  cog: string;
  aliases: string[];
  ownerOnly: boolean;
  guildOnly: boolean;
}

const CATEGORY_ORDER = [
  "manager",
  "music",
  "utility",
  "chat",
  "events",
  "sound",
  "record",
  "ytdlp",
  "webPanel",
];

const CATEGORY_LABELS: Record<string, string> = {
  chat: "Chat",
  events: "Events",
  manager: "Manager",
  music: "Music",
  record: "Record",
  sound: "Sound",
  utility: "Utility",
  webPanel: "Web Panel",
  ytdlp: "YT-DLP",
};

export function collectHelpEntries(bot: GlizzBot): HelpEntry[] {
  const unique = new Map<string, BotCommand>();
  for (const command of bot.commands.values()) {
    unique.set(command.name, command);
  }

  return [...unique.values()]
    .sort((a, b) => compareCogs(a.cog, b.cog) || a.name.localeCompare(b.name))
    .map((command) => ({
      name: command.name,
      description: command.description,
      cog: command.cog,
      aliases: command.aliases ?? [],
      ownerOnly: command.ownerOnly ?? false,
      guildOnly: command.guildOnly ?? false,
    }));
}

function compareCogs(left: string, right: string): number {
  const leftIndex = CATEGORY_ORDER.indexOf(left);
  const rightIndex = CATEGORY_ORDER.indexOf(right);

  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
      - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
  }

  return left.localeCompare(right);
}

function formatCategoryLabel(cog: string): string {
  return CATEGORY_LABELS[cog] ?? cog.charAt(0).toUpperCase() + cog.slice(1);
}

export function buildHelpPages(bot: GlizzBot): EmbedBuilder[] {
  const entries = collectHelpEntries(bot);
  const pages: EmbedBuilder[] = [];
  const groupedEntries = new Map<string, HelpEntry[]>();

  for (const entry of entries) {
    const bucket = groupedEntries.get(entry.cog) ?? [];
    bucket.push(entry);
    groupedEntries.set(entry.cog, bucket);
  }

  if (entries.length > 0) {
    pages.push(buildOverviewPage(bot, groupedEntries, entries.length));
  }

  for (const [cog, categoryEntries] of groupedEntries) {
    for (let start = 0; start < categoryEntries.length; start += HELP_PAGE_SIZE) {
      const chunk = categoryEntries.slice(start, start + HELP_PAGE_SIZE);
      const categoryLabel = formatCategoryLabel(cog);
      const categoryPage = Math.floor(start / HELP_PAGE_SIZE) + 1;
      const categoryPages = Math.ceil(categoryEntries.length / HELP_PAGE_SIZE);
      const title = categoryPages > 1
        ? `Help: ${categoryLabel} ${categoryPage}/${categoryPages}`
        : `Help: ${categoryLabel}`;

      pages.push(
        new EmbedBuilder()
          .setColor(HELP_EMBED_COLOR)
          .setTitle(title)
          .setDescription(`${categoryEntries.length} command(s) in ${categoryLabel}.`)
          .addFields(
            chunk.map((command) => ({
              name: `${bot.config.prefix}${command.name}`,
              value: formatCommandDetails(bot.config.prefix, command),
              inline: false,
            })),
          ),
      );
    }
  }

  const totalPages = Math.max(1, pages.length);
  pages.forEach((page, index) => {
    page.setFooter({
      text: `Prefix: ${bot.config.prefix} | Page ${index + 1}/${totalPages} | Closes after 2 minutes`,
    });
  });

  return pages.length > 0
    ? pages
    : [
        new EmbedBuilder()
          .setColor(HELP_EMBED_COLOR)
          .setTitle("Help")
          .setDescription("No commands are currently enabled.")
          .setFooter({
            text: `Prefix: ${bot.config.prefix} | Page 1/1`,
          }),
      ];
}

function buildOverviewPage(
  bot: GlizzBot,
  groupedEntries: Map<string, HelpEntry[]>,
  totalCommands: number,
): EmbedBuilder {
  const categoryFields = [...groupedEntries.entries()].map(([cog, categoryEntries]) => {
    const preview = categoryEntries
      .slice(0, 5)
      .map((entry) => `\`${bot.config.prefix}${entry.name}\``)
      .join(", ");
    const remaining = categoryEntries.length > 5 ? `, +${categoryEntries.length - 5} more` : "";

    return {
      name: `${formatCategoryLabel(cog)} (${categoryEntries.length})`,
      value: `${preview}${remaining}`,
      inline: false,
    };
  });

  return new EmbedBuilder()
    .setColor(HELP_EMBED_COLOR)
    .setTitle("Help")
    .setDescription(
      [
        `${totalCommands} command(s) available across ${groupedEntries.size} categor${groupedEntries.size === 1 ? "y" : "ies"}.`,
        `Use \`${bot.config.prefix}<command>\` to run a command.`,
        "Navigate pages for descriptions, aliases, and access notes.",
      ].join("\n"),
    )
    .addFields(categoryFields);
}

function formatCommandDetails(prefix: string, command: HelpEntry): string {
  const details = [command.description];

  if (command.aliases.length > 0) {
    details.push(`Aliases: ${command.aliases.map((alias) => `\`${prefix}${alias}\``).join(", ")}`);
  }

  const access = [
    command.guildOnly ? "server only" : null,
    command.ownerOnly ? "owner only" : null,
  ].filter(Boolean);

  if (access.length > 0) {
    details.push(`Access: ${access.join(", ")}`);
  }

  return details.join("\n");
}

function buildHelpComponents(pageIndex: number, totalPages: number) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId("help:prev")
        .setLabel("Previous")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageIndex === 0),
      new ButtonBuilder()
        .setCustomId("help:next")
        .setLabel("Next")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(pageIndex >= totalPages - 1),
    ),
  ];
}

export function createHelpCommand(bot: GlizzBot): BotCommand {
  return {
    name: "help",
    cog: "manager",
    description: "List bot commands.",
    async execute(ctx) {
      const pages = buildHelpPages(bot);
      let pageIndex = 0;

      const helpMessage = await ctx.message.reply({
        embeds: [pages[pageIndex]],
        components: buildHelpComponents(pageIndex, pages.length),
      });

      const collector = helpMessage.createMessageComponentCollector({
        componentType: ComponentType.Button,
        time: HELP_TIMEOUT_MS,
      });

      collector.on("collect", async (interaction) => {
        if (interaction.user.id !== ctx.message.author.id) {
          await interaction.reply({
            content: "Only the person who ran `help` can use these buttons.",
            ephemeral: true,
          }).catch(() => null);
          return;
        }

        pageIndex += interaction.customId === "help:next" ? 1 : -1;
        pageIndex = Math.max(0, Math.min(pageIndex, pages.length - 1));

        await interaction.update({
          embeds: [pages[pageIndex]],
          components: buildHelpComponents(pageIndex, pages.length),
        }).catch(() => null);
      });

      collector.on("end", async () => {
        await helpMessage.delete().catch(() => null);
      });
    },
  };
}
