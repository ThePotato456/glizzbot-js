# GlizzBot JS

TypeScript/Node reimplementation scaffold of the GlizzBot functionality described in `FUNCTIONALITY.md`.

## Quick start

1. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN`.
2. Copy `config/config.example.json` to `config/config.json` if you want to customize defaults before first boot.
3. Install dependencies with `npm install`.
4. Run `npm run dev`.

## Current scope

- Central config loading with defaults, env overrides, and per-guild helpers
- Custom bot runtime with command logging and event-loop lag monitoring
- In-memory command system with modular command files
- Music queue/state scaffolding
- Utility/admin command scaffolding
- Local web panel with `/api/status` and `/api/export`

Several subsystems from `FUNCTIONALITY.md` are intentionally scaffolded behind services and command surfaces so the repo has a clean architecture to extend for full media, scheduled-event, recording, and downloader integrations.
