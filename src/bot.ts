import {
  Client,
  Collection,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";
import { ConfigStore } from "./config.js";
import { AppLogger } from "./logger.js";
import { MusicService } from "./services/musicService.js";
import { MusicResolverService } from "./services/musicResolverService.js";
import { ChatService } from "./services/chatService.js";
import { EventsService } from "./services/eventsService.js";
import type { AppConfig, BotCommand, CommandContext, QueueItem, RuntimePaths } from "./types.js";
import { buildCommands } from "./commands/index.js";
import { buildTrackEmbed } from "./commands/musicEmbeds.js";
import { startWebPanel } from "./web/panel.js";

export class GlizzBot extends Client {
  readonly commands = new Collection<string, BotCommand>();
  readonly music: MusicService;
  readonly musicResolver: MusicResolverService;
  readonly chat = new ChatService();
  readonly events = new EventsService();
  readonly configStore: ConfigStore;
  readonly logger: AppLogger;
  private lagMs = 0;

  constructor(
    readonly config: AppConfig,
    readonly paths: RuntimePaths,
  ) {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.configStore = new ConfigStore(paths);
    this.logger = new AppLogger(paths, config.debug);
    this.musicResolver = new MusicResolverService(paths);
    this.music = new MusicService(
      config.music.idleDisconnectMs,
      config.music.shouldLeaveWhenIdle,
      config.music.timingDebugDefault,
    );
    this.logger.debug(`Voice dependency report:\n${this.music.getDependencyReport()}`);
    this.music.setTrackFinishedHandler(async (guildId) => {
      const started = await this.music.advancePlayback(guildId, this.musicResolver);
      await this.announceNowPlaying(guildId, started);
    });
  }

  async bootstrap(): Promise<void> {
    this.registerEventHandlers();
    this.registerCommands(buildCommands(this));
    this.startLagMonitor();
    if (this.config.webPanel.enabled) {
      startWebPanel(this, this.config.webPanel.port, this.config.webPanel.token);
    }
    await this.login(this.config.discord.token);
  }

  isOwner(userId: string): boolean {
    return userId === this.config.discord.ownerId;
  }

  getLagMs(): number {
    return this.lagMs;
  }

  private registerCommands(commands: BotCommand[]): void {
    for (const command of commands) {
      if (!this.config.enabledCogs.includes(command.cog)) {
        continue;
      }
      this.commands.set(command.name, command);
      for (const alias of command.aliases ?? []) {
        this.commands.set(alias, command);
      }
    }
  }

  private registerEventHandlers(): void {
    this.once("clientReady", () => {
      this.logger.info(`Logged in as ${this.user?.tag ?? "unknown user"}`);
    });

    this.on("guildCreate", async (guild) => {
      const nextConfig = this.configStore.ensureGuildEntry(this.config, guild.id);
      Object.assign(this.config, nextConfig);
      this.logger.info(`Joined guild ${guild.name} (${guild.id})`);
    });

    this.on("messageCreate", async (message) => {
      await this.handleMessage(message);
    });

    this.on("error", (error) => {
      this.logger.error(`Discord client error: ${error.stack ?? error.message}`);
    });

    process.on("unhandledRejection", (reason) => {
      const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
      this.logger.error(`Unhandled rejection: ${message}`);
    });
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.content.startsWith(this.config.prefix)) {
      return;
    }

    const withoutPrefix = message.content.slice(this.config.prefix.length).trim();
    const [commandName = "", ...args] = withoutPrefix.split(/\s+/);
    const command = this.commands.get(commandName.toLowerCase());
    if (!command) {
      return;
    }

    if (command.ownerOnly && !this.isOwner(message.author.id)) {
      await message.reply("This command is owner-only.");
      return;
    }

    if (command.guildOnly && !message.guild) {
      await message.reply("This command can only be used inside a server.");
      return;
    }

    if (message.guild) {
      const guildConfig = this.configStore.getGuildConfig(this.config, message.guild.id);
      if (guildConfig.blockedUsers.includes(message.author.id)) {
        await message.reply("You are blocked from using this bot in this server.");
        return;
      }
    }

    const ctx: CommandContext = {
      message,
      args,
      rawArgs: args.join(" "),
      guild: message.guild,
      member: message.member,
      channel: message.channel,
      reply: (content: string) => message.reply(content),
    };

    this.logger.info(`command start: ${command.name} by ${message.author.tag}`);
    try {
      await command.execute(ctx);
      this.logger.info(`command complete: ${command.name} by ${message.author.tag}`);
    } catch (error) {
      const details = error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.error(`command error: ${command.name}: ${details}`);
      const userMessage = this.getUserFacingCommandError(error);
      await message.reply(userMessage);
    }
  }

  private startLagMonitor(): void {
    let expected = performance.now() + 1000;
    setInterval(() => {
      const now = performance.now();
      this.lagMs = Math.max(0, now - expected);
      expected = now + 1000;
    }, 1000).unref();
  }

  private async announceNowPlaying(guildId: string, track: QueueItem | null): Promise<void> {
    if (!track) {
      return;
    }

    const state = this.music.getState(guildId);
    const textChannelId = state.textChannelId;
    if (!textChannelId) {
      return;
    }

    const channel = this.channels.cache.get(textChannelId) ?? await this.channels.fetch(textChannelId).catch(() => null);
    if (!channel?.isTextBased() || !("send" in channel) || typeof channel.send !== "function") {
      return;
    }

    const embed = buildTrackEmbed("Now Playing", track);
    if (state.queue.length > 0) {
      embed.setFooter({ text: `${state.queue.length} track(s) remaining in queue.` });
    }

    await channel.send({ embeds: [embed] }).catch((error: unknown) => {
      const details = error instanceof Error ? error.stack ?? error.message : String(error);
      this.logger.error(`Failed to announce now playing for guild ${guildId}: ${details}`);
    });
  }

  private getUserFacingCommandError(error: unknown): string {
    if (!(error instanceof Error)) {
      return "That command failed. Check logs or the web panel for details.";
    }

    const userFacingPrefixes = [
      "Join a voice channel first.",
      "Stage voice channels are not supported yet.",
      "Your voice channel is full, so I cannot join it.",
      "Discord reports that I cannot join that voice channel.",
      "Discord reports that I cannot speak in that voice channel.",
      "Discord rejected the voice connection because this channel requires DAVE end-to-end encryption",
      "I do not have permission to view that voice channel.",
      "I do not have permission to connect to that voice channel.",
      "I do not have permission to speak in that voice channel.",
      "Could not connect to your voice channel before timeout.",
    ];

    return userFacingPrefixes.some((prefix) => error.message.startsWith(prefix))
      ? error.message
      : "That command failed. Check logs or the web panel for details.";
  }
}
