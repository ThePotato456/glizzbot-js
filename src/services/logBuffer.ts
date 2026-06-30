export interface BufferedLogLine {
  at: string;
  level: "info" | "warn" | "error" | "debug";
  message: string;
}

export class LogBuffer {
  private readonly lines: BufferedLogLine[] = [];

  constructor(private readonly maxEntries = 500) {}

  push(level: BufferedLogLine["level"], message: string): void {
    this.lines.push({ at: new Date().toISOString(), level, message });
    if (this.lines.length > this.maxEntries) {
      this.lines.shift();
    }
  }

  snapshot(): BufferedLogLine[] {
    return [...this.lines];
  }
}
