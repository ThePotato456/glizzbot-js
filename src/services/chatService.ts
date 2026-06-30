import type { ConversationMessage } from "../types.js";

export class ChatService {
  private readonly conversations = new Map<string, ConversationMessage[]>();
  private readonly personas = new Map<string, string>();

  getConversation(guildId: string): ConversationMessage[] {
    return this.conversations.get(guildId) ?? [];
  }

  setPersona(guildId: string, systemPrompt: string): void {
    this.personas.set(guildId, systemPrompt);
    this.reset(guildId);
  }

  reset(guildId: string): void {
    const systemPrompt = this.personas.get(guildId) ?? "You are a helpful Discord bot.";
    this.conversations.set(guildId, [{ role: "system", content: systemPrompt }]);
  }

  ensure(guildId: string): void {
    if (!this.conversations.has(guildId)) {
      this.reset(guildId);
    }
  }

  async chat(guildId: string, prompt: string): Promise<string> {
    this.ensure(guildId);
    const messages = this.conversations.get(guildId)!;
    messages.push({ role: "user", content: prompt });

    const response = `Local AI backend not configured yet. Stored prompt: "${prompt.slice(0, 120)}"`;
    messages.push({ role: "assistant", content: response });
    return response;
  }
}
