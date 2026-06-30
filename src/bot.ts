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
import { SoundService } from "./services/soundService.js";
import type { AppConfig, BotCommand, CommandContext, RuntimePaths } from "./types.js";
import { buildCommands } from "./commands/index.js";
import { startWebPanel } from "./web/panel.js";

export class GlizzBot extends Client {
  readonly commands = new Collection<string, BotCommand>();
  readonly music: MusicService;
  readonly musicResolver = new MusicResolverService();
  readonly chat = new ChatService();
  readonly events = new EventsService();
  readonly sounds: SoundService;
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
    this.music = new MusicService(
      config.music.idleDisconnectMs,
      config.music.shouldLeaveWhenIdle,
      config.music.timingDebugDefault,
    );
    this.sounds = new SoundService(paths);
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
    this.once("ready", () => {
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
      await message.reply("That command failed. Check logs or the web panel for details.");
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
}
