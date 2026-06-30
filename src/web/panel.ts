import express from "express";
import type { Request, Response, NextFunction } from "express";
import type { GlizzBot } from "../bot.js";

function authMiddleware(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!token) {
      next();
      return;
    }
    const candidate = req.header("x-panel-token") ?? String(req.query.token ?? "");
    if (candidate !== token) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function startWebPanel(bot: GlizzBot, port: number, token: string): void {
  const app = express();
  app.use(authMiddleware(token));

  app.get("/", (_req, res) => {
    res.type("html").send(`
      <html>
        <head><title>GlizzBot Panel</title></head>
        <body>
          <h1>GlizzBot</h1>
          <p>Status API: <a href="/api/status">/api/status</a></p>
          <p>Export API: <a href="/api/export">/api/export</a></p>
        </body>
      </html>
    `);
  });

  app.get("/api/status", (_req, res) => {
    const loadedCommands = [...new Set([...bot.commands.values()].map((command) => command.name))];
    res.json({
      user: bot.user?.tag ?? null,
      guildCount: bot.guilds.cache.size,
      gatewayPingMs: bot.ws.ping,
      eventLoopLagMs: bot.getLagMs(),
      loadedCommands,
      musicStates: bot.music.exportState(),
      logs: bot.logger.buffer.snapshot().slice(-50),
    });
  });

  app.get("/api/export", (_req, res) => {
    res.json({
      exportedAt: new Date().toISOString(),
      status: {
        guildCount: bot.guilds.cache.size,
        gatewayPingMs: bot.ws.ping,
        eventLoopLagMs: bot.getLagMs(),
      },
      musicStates: bot.music.exportState(),
      logs: bot.logger.buffer.snapshot(),
      memoryUsage: process.memoryUsage(),
      uptimeSeconds: process.uptime(),
    });
  });

  app.listen(port, () => {
    bot.logger.info(`Web panel listening on http://localhost:${port}`);
  });
}
