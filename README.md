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
- `ffmpeg` available on `PATH`
- `yt-dlp` available on `PATH`

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
- Discord credentials
- music idle disconnect behavior
- web panel settings
- per-guild defaults

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
