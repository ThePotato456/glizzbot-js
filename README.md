# GlizzBot JS

GlizzBot JS is a TypeScript/Node.js rewrite of GlizzBot focused on practical Discord music playback, modern project structure, and voice compatibility with newer Discord voice environments.

The current build includes a custom DAVE-capable voice transport, yt-dlp-backed music resolution, queue management, playlist expansion, and a lightweight local web status panel.

## Features

- Discord.js bot runtime with modular command loading
- Music playback from search queries or direct URLs
- YouTube playlist expansion into queued tracks
- yt-dlp stream resolution with deferred per-track refresh
- Custom DAVE/E2EE-compatible voice transport for Discord voice channels that require it
- Queue controls including play, skip, pause, resume, shuffle, remove, insert, and clear
- Simple GlizzBot-style music embeds for public bot responses
- Voice diagnostics commands for troubleshooting
- Local web panel for status and export endpoints
- Automated tests covering commands, resolver behavior, music state, and DAVE session logic

## Requirements

- Node.js 22+
- `ffmpeg` available on `PATH`, or configured explicitly
- `yt-dlp` available on `PATH`, or configured explicitly

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Copy your config template:

```bash
copy config\config.example.json config\config.json
```

3. Set your Discord bot token and owner id in `config/config.json`.

4. Start the bot in development mode:

```bash
npm run dev
```

5. Or build and run the compiled output:

```bash
npm run build
npm start
```

## Make Targets

If you use `make`, the project includes a small Windows-friendly `Makefile`:

```bash
make install
make dev
make build
make run
make test
```

## Music Commands

Current core music commands include:

- `!play <query or url>`
- `!queue`
- `!nowplaying`
- `!skip`
- `!pause`
- `!resume`
- `!stop`
- `!clear`
- `!shuffle`
- `!remove <index>`
- `!insert <index> <query>`
- `!join`
- `!leave`
- `!voicecheck`
- `!voiceenv`
- `!timing`

## Configuration

Runtime settings live in:

- `config/config.json`

The example config shows:

- command prefix
- enabled cogs
- runtime binary paths and optional legacy DB import path
- Discord credentials
- music idle disconnect behavior
- web panel settings
- per-guild defaults

The portable runtime block is:

```json
"runtime": {
  "ffmpegPath": "ffmpeg",
  "ytDlpPath": "yt-dlp",
  "legacyDatabaseImportPath": null
}
```

Notes:

- `ffmpegPath` and `ytDlpPath` can be either command names on `PATH` or explicit relative/absolute paths.
- `legacyDatabaseImportPath` is optional. If set, the bot will import that DB the first time local `config/database.db` is missing.
- Environment overrides are supported:
  - `FFMPEG_PATH`
  - `YTDLP_PATH`
  - `LEGACY_DATABASE_IMPORT_PATH`
  - `DISCORD_TOKEN`
  - `BOT_OWNER_ID`
  - `WEB_PANEL_TOKEN`

## Portability

This repo is now set up so the application code itself is architecture-neutral. The host-specific pieces are:

- Node runtime
- `ffmpeg`
- `yt-dlp`
- your mounted config/database files

For direct host installs, point `runtime.ffmpegPath` and `runtime.ytDlpPath` at the right binaries for that machine.

For the easiest moveable deployment, use the included Docker image.

### Docker

Build locally:

```bash
docker build -t glizzbot-js .
```

Run with your config mounted:

```bash
docker run --rm \
  -p 3000:3000 \
  -v $(pwd)/config:/app/config \
  glizzbot-js
```

For multi-arch builds with Buildx:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  -t your-registry/glizzbot-js:latest \
  --push .
```

That gives you one image tag that can move between common x64 and ARM64 Linux hosts.

## Project Status

This repository is actively evolving. The music pipeline is functional and the custom voice transport is working, but some broader GlizzBot surfaces are still partial or scaffolded compared with the original Python bot.

Examples of still-in-progress areas:

- Spotify collection support
- richer queue pagination/UI
- full downloader workflows
- recording pipeline
- broader event automation

## Development

Run the test suite with:

```bash
npm test
```

The current test coverage focuses on:

- command behavior
- music queue state
- playlist expansion
- yt-dlp resolution fallback behavior
- DAVE session transitions and proposal handling
- voice playback scheduling helpers

## Notes

- This project depends on external tools (`ffmpeg` and `yt-dlp`) for media handling.
- Some Discord voice channels now require DAVE/E2EE negotiation; this rewrite includes a custom transport to handle that case.
- Timing diagnostics are available for troubleshooting but are intended as a debug tool rather than normal day-to-day usage.
