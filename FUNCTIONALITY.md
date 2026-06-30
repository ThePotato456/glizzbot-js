# GlizzBot Functionality

This document summarizes the current bot, grouped by subsystem, and turns that into a reimplementation checklist. It is written from the current codebase, not just the README.

## High-Level Summary

GlizzBot is a py-cord Discord bot built around a modular cog architecture. Its main responsibilities are:

- bootstrapping the app and validating config
- loading and managing cogs
- music playback with queueing, playlist support, Spotify helpers, caching, history, and diagnostics
- lightweight utility/admin commands
- UFC event discovery and Discord scheduled-event management
- soundboard-style short audio playback
- owner-only voice recording
- optional local AI chat
- yt-dlp based media downloading and auto-link handling
- a local web status/debug panel

## Core Architecture

### Entrypoint and Bot Runtime

Files:

- [bot.py](C:/Users/User/Documents/vscode_projects/GlizzBot/bot.py)
- [app_config.py](C:/Users/User/Documents/vscode_projects/GlizzBot/app_config.py)

What it does:

- loads `.env`
- loads and validates `config/config.json`
- merges config defaults with runtime overrides
- applies secret overrides from environment variables
- configures Discord logging
- starts a custom `GlizzBot` subclass
- registers a custom paginated help command
- loads enabled cogs from `cogs/`
- installs an asyncio loop exception handler
- tracks event loop lag
- records bot-side log lines for the web panel/export
- auto-creates missing per-guild config entries when joining a server

Reimplementation steps:

- [ ] Create a central config module with defaults, validation, and env overrides.
- [ ] Build a custom `commands.Bot` subclass instead of scattering startup logic across cogs.
- [ ] Add a custom help command and remove the default one.
- [ ] Add runtime logging for both Discord internals and bot-specific events.
- [ ] Add an event loop lag monitor and expose the measured lag to the rest of the app.
- [ ] Add command lifecycle logging (`start`, `complete`, `error`).
- [ ] Add a shared in-memory bot log buffer for the web panel/export.
- [ ] Load cogs dynamically from `cogs/`, honoring `ENABLED_COGS`.

## Configuration Model

Files:

- [app_config.py](C:/Users/User/Documents/vscode_projects/GlizzBot/app_config.py)
- [config/config.example.json](C:/Users/User/Documents\vscode_projects\GlizzBot\config\config.example.json)
- [config/config.json](C:/Users/User/Documents\vscode_projects\GlizzBot\config\config.json)

What it does:

- defines top-level defaults for debug, Discord, Spotify, web panel, yt-dlp, and events
- defines per-guild defaults for admins, command channel restrictions, ping configuration, channel whitelist, and blocked users
- saves config back to disk when needed
- supports env overrides for secrets like `DISCORD_TOKEN`, Spotify credentials, OpenAI key, and web panel token

Reimplementation steps:

- [ ] Define a single authoritative config schema with nested defaults.
- [ ] Split global config from per-guild config.
- [ ] Implement safe merging of defaults with user config.
- [ ] Implement secret override support from environment variables.
- [ ] Validate required runtime fields before boot.
- [ ] Add helper functions for reading and mutating per-guild config.

## Cog System and Runtime Management

Files:

- [cogs/manager.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\manager.py)

What it does:

- lists available cogs
- loads, unloads, and reloads extensions at runtime
- supports `reloadall`
- prevents unloading the manager from itself
- restricts these operations to the bot owner

Reimplementation steps:

- [ ] Add an owner-only cog manager.
- [ ] Normalize cog names to a canonical `cogs.<name>` format.
- [ ] Support `load`, `unload`, `reload`, `reloadall`, and `listcogs`.
- [ ] Show action status in ephemeral/temporary embeds.
- [ ] Protect against unloading the manager itself.

## Music System

Files:

- [cogs/music.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\music.py)
- [utils.py](C:/Users/User/Documents\vscode_projects\GlizzBot\utils.py)
- [config/database.db](C:/Users/User/Documents\vscode_projects\GlizzBot\config\database.db)

This is the largest subsystem in the project.

### Music Playback and Queueing

What it does:

- joins the requester’s voice channel
- resolves a query into a playable source
- plays a single track or queues it
- supports advancing to the next track via the playback callback
- keeps per-guild queue state
- disconnects after an idle delay when configured to leave
- treats paused audio as active playback
- uses a playback lock to serialize queue advancement

Key commands:

- `play` / `p`
- `queue` / `q`
- `nowplaying` / `np`
- `skip` / `s`
- `stop`
- `clear`
- `insert`
- `shuffle` / `sh`
- `remove`
- `noleave`
- `timing`

Reimplementation steps:

- [ ] Build a per-guild music state object containing queue, voice client, current track, retry/debug state, and playback lock.
- [ ] Add helpers for connecting to the caller’s voice channel and resolving the active voice client.
- [ ] Implement `play` for search queries, direct URLs, YouTube playlists, and Spotify URLs.
- [ ] Implement a serialized `play_next_async()` queue handoff path.
- [ ] Use the Discord `after` callback to schedule async queue advancement safely onto the event loop.
- [ ] Implement delayed disconnect when queue is empty and `should_leave` is enabled.
- [ ] Add `skip`, `stop`, `clear`, `insert`, `shuffle`, and `remove`.
- [ ] Add `queue` and `nowplaying` embeds.
- [ ] Add a toggle for whether timing/debug output is shown.

### Lazy Queue Resolution and Prefetching

What it does:

- queues URL placeholders for playlists and large Spotify collections
- resolves the actual stream metadata only when a track is near playback
- prefetches the next queued item in the background
- skips unresolved or unavailable items instead of stalling the queue

Reimplementation steps:

- [ ] Introduce a lightweight queue item format for unresolved URL entries.
- [ ] Resolve queued URL items immediately before playback.
- [ ] Add one-track-ahead background prefetching.
- [ ] Ensure prefetch failures do not crash playback.
- [ ] Skip broken queued items and continue advancing.

### Audio Caching

What it does:

- downloads audio for playback into a local cache path
- prefers cached local audio when available
- marks cached items as local so FFmpeg playback can use local file input
- logs cache start, success, fallback, and reuse behavior in debug mode

Reimplementation steps:

- [ ] Add a helper to download playable audio to a local file.
- [ ] Reuse a local file if `stream_url` already points to an existing file.
- [ ] Mark cached tracks with metadata like `_local_audio`.
- [ ] Use local files for playback when available.
- [ ] Log cache outcomes for diagnostics.

### Search and Source Resolution

What it does:

- accepts direct YouTube, YouTube Music, SoundCloud, and Spotify URLs
- accepts plain-text search terms and resolves them to YouTube matches
- distinguishes playlists from single items
- falls back to yt-dlp/download methods when track extraction fails

Reimplementation steps:

- [ ] Build a source resolver that classifies query types.
- [ ] Normalize YouTube and Spotify URLs before processing.
- [ ] Add YouTube search fallback for plain-text queries.
- [ ] Add track metadata extraction with a fallback download path.
- [ ] Keep source resolution async or move blocking work off the event loop.

### Spotify Integration

What it does:

- supports Spotify track, album, and playlist URLs
- looks up Spotify metadata using Spotipy
- converts Spotify tracks into YouTube matches
- queues albums and playlists as lazy YouTube-backed entries
- supports background matching for large collections
- exposes Spotify info commands and feature toggles

Key commands:

- `spotify_to_youtube` / `syt`
- `salbum`
- `splaylist`
- `sinfo`

Reimplementation steps:

- [ ] Add Spotify client initialization from config/env credentials.
- [ ] Add feature gates for Spotify tracks, playlists, albums, and wrapper commands.
- [ ] Resolve Spotify tracks to YouTube URLs using search heuristics.
- [ ] Implement album and playlist collection fetching with pagination.
- [ ] Queue Spotify collections as lazy YouTube entries.
- [ ] Add background processing for remaining collection items.
- [ ] Add a metadata info command for track/album/playlist inspection.

### Song History and Persistence

What it does:

- stores songs in SQLite
- stores song history and requester information
- supports random/history-based playback features
- backfills legacy history user IDs on startup

Likely user-facing commands in this area:

- `songhistory`
- `playrandom`
- `songlink`

Reimplementation steps:

- [ ] Create SQLite schema and migrations for songs/history.
- [ ] Save tracks when they are queued or successfully played, depending on flow.
- [ ] Record requester identity with the history entry.
- [ ] Add history browsing and random replay helpers.
- [ ] Add one-time maintenance/backfill tasks for legacy rows.

### Music Diagnostics

What it does:

- captures detailed playback debug events when `DEBUG` is enabled
- logs playback start/end, queue advancement, skip/stop reasons, cache events, and voice state
- records incident snapshots for export
- exposes a `markaudio` command to bookmark a moment for later debug export
- tracks playback timing so exports can show expected vs elapsed duration

Key command:

- `markaudio`

Reimplementation steps:

- [ ] Add structured debug logging around all playback state transitions.
- [ ] Add explicit stop reasons for manual `skip` and `stop`.
- [ ] Record passive incident snapshots that can be exported later.
- [ ] Track timing fields like `started_at`, `elapsed`, and expected duration.
- [ ] Add a manual “mark current audio state” command for user-triggered debug bookmarks.

## Utility and Admin Commands

Files:

- [cogs/commands.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\commands.py)

What it does:

- voice-channel mass move and targeted move utilities
- hidden owner/server administration commands
- transcript export for one channel or all text channels in a guild
- Google search helper
- curve-font text conversion
- role ping helper using per-guild config
- blocked-user checks for some commands

Commands seen in code:

- `chinfo`
- `massmove`
- `move`
- `leaveserver`
- `servers`
- `createinvite`
- `deleteinvite`
- `listinvites`
- `cleanupinvites`
- `channels`
- `save`
- `saveall`
- `google`
- `curvetext`
- `ping`

Reimplementation steps:

- [ ] Add a general utility cog for non-music commands.
- [ ] Implement voice move helpers using Discord member/channel objects.
- [ ] Add owner-only guild/invite management commands.
- [ ] Add transcript export to HTML attachments.
- [ ] Add simple Google search output formatting.
- [ ] Add curve-text conversion and configured role-ping support.
- [ ] Honor per-guild blocked user settings where applicable.

## UFC Events Module

Files:

- [cogs/events.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\events.py)

What it does:

- fetches UFC event data from ESPN
- parses event metadata into a normalized model
- previews upcoming events in Discord
- creates Discord scheduled events for UFC cards
- lists existing UFC scheduled events in a guild
- clears UFC scheduled events
- supports configurable lookahead/lookback windows, event duration, channel, and image

Commands:

- `ufcevents` / `ufc`
- `schedule` / `scheduleufc`
- `events`
- `clearufc` / `clearufcevents`

Reimplementation steps:

- [ ] Add a data model for external event records.
- [ ] Fetch ESPN UFC scoreboard data with date-window filtering.
- [ ] Parse and normalize event names, times, and location data.
- [ ] Build preview embeds for upcoming events.
- [ ] Create Discord scheduled events with optional image support.
- [ ] Detect and skip already-scheduled duplicate UFC events.
- [ ] Add list and clear commands for scheduled UFC events.
- [ ] Add cooldowns and permission checks for scheduler actions.

## Soundboard Module

Files:

- [cogs/sound.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\sound.py)
- `audio/sounds.json` at runtime

What it does:

- joins the caller’s voice channel
- plays a named local sound clip
- disconnects after playback
- lists available sounds and metadata
- reports clip lengths

Commands:

- `playsound`
- `sounds`

Reimplementation steps:

- [ ] Create an `audio/` directory and `sounds.json` manifest.
- [ ] Load sound metadata at startup.
- [ ] Implement local FFmpeg playback for named clips.
- [ ] Auto-disconnect after the clip finishes.
- [ ] Add a sound listing/info command.

## Voice Recording Module

Files:

- [cogs/record.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\record.py)

What it does:

- owner-only voice recording for a target voice channel
- uses py-cord recording sinks
- writes per-user MP3 files into `recordings/`
- posts the recorded files back into Discord
- supports time-based stop or manual stop

Commands:

- `vcrecord`
- `stoprecord`

Reimplementation steps:

- [ ] Add owner-only record/start and stop commands.
- [ ] Connect to a target voice channel or fall back to the caller’s channel.
- [ ] Start a recording sink and persist active recording state per guild.
- [ ] Save output files under a recordings directory with timestamped filenames.
- [ ] Send resulting files and metadata back into the text channel.
- [ ] Disconnect cleanly when recording ends.

## Optional AI Chat Module

Files:

- [cogs/chatgpt.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\chatgpt.py)

What it does:

- keeps per-guild chat history
- supports persona switching
- sends chat to a local Ollama-compatible model host
- shows conversation history
- estimates token usage

Commands:

- `changepersona`
- `reset`
- `convo`
- `chat`
- `tokens`
- `personas`

Reimplementation steps:

- [ ] Add a per-guild conversation state store.
- [ ] Add persona definitions and default system prompt handling.
- [ ] Connect to a local LLM backend such as Ollama.
- [ ] Implement chat, reset, persona switch, and conversation inspection commands.
- [ ] Add lightweight token estimation for visibility.

## yt-dlp Download Module

Files:

- [cogs/ytdlp.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\ytdlp.py)

What it does:

- downloads media from yt-dlp-supported URLs
- supports `best`, `audio`, and `video` modes
- uploads downloaded files to a remote host via `scp`
- returns a public URL for the uploaded file
- optionally auto-downloads supported URLs posted by opted-in users
- can also respond when the bot is mentioned in reply to a message containing URLs
- persists the list of auto-enabled users

Commands:

- `dl` / `ytdlp` / `ytdl` / `download`
- `dlauto` / `ytdlpauto` / `ydlauto` / `autodl`

Reimplementation steps:

- [ ] Add a yt-dlp integration layer with configurable output modes.
- [ ] Stage downloads in a local working directory.
- [ ] Upload completed files to a remote server over SCP.
- [ ] Return a public URL instead of keeping large files locally.
- [ ] Persist the set of users with auto-download enabled.
- [ ] Add an `on_message` flow for automatic URL detection.
- [ ] Avoid recursive handling of already-public uploaded links.
- [ ] Serialize downloads per user to avoid overlapping jobs.

## Web Panel and Debug Export

Files:

- [cogs/web_panel.py](C:/Users/User/Documents\vscode_projects\GlizzBot\cogs\web_panel.py)

What it does:

- runs a local HTTP server in a background thread
- serves a read-only web dashboard
- shows runtime status, latency, lag, guilds, loaded cogs, active voice sessions, queue state, and recent history
- shows health checks and log tails
- exports a large JSON debug snapshot
- includes music diagnostics, music incidents, recent logs, parsed tracebacks, live thread stacks, and asyncio task snapshots
- supports optional token auth

Endpoints/functionality present in code:

- panel HTML UI
- `/api/status`
- `/api/export`

Reimplementation steps:

- [ ] Add a lightweight HTTP server separate from Discord event handling.
- [ ] Serve a simple read-only dashboard page.
- [ ] Add a JSON status API with runtime metrics and music state.
- [ ] Add optional header/query token auth for the panel.
- [ ] Add a downloadable debug export endpoint.
- [ ] Include bot logs, Discord logs, music diagnostics, tracebacks, thread stacks, and task snapshots in the export.
- [ ] Keep the panel read-only.

## Shared Utilities

Files:

- [utils.py](C:/Users/User/Documents\vscode_projects\GlizzBot\utils.py)

What it likely centralizes:

- embed helpers
- guild config lookups
- curve-text formatting
- YouTube search/extraction helpers
- audio length/time helpers
- DB helpers
- debug message helpers

Reimplementation steps:

- [ ] Move repeated embed/message helpers into a shared utility module.
- [ ] Centralize config accessors there only if they stay thin.
- [ ] Centralize media helper functions used by music/sound/yt-dlp.
- [ ] Centralize formatting helpers such as durations and curve-font output.

## Data and Runtime Directories

Runtime directories/files used by the bot:

- `config/config.json`
- `config/database.db`
- `downloads/`
- `temp/ytdlp/`
- `audio/`
- `audio/sounds.json`
- `recordings/`
- `discord.log`

Reimplementation steps:

- [ ] Define all runtime directories in one place.
- [ ] Ensure required directories are created automatically.
- [ ] Separate persistent data from temporary staging data.
- [ ] Document cleanup expectations for downloads, recordings, and staged yt-dlp files.

## Suggested Reimplementation Order

Use this as the top-level progress tracker.

- [ ] 1. Core boot/config/logging
- [ ] 2. Shared utilities and embeds
- [ ] 3. Cog loader and manager
- [ ] 4. Music core playback/queue state
- [ ] 5. Music source resolution and caching
- [ ] 6. Music playlists, lazy queue items, and prefetch
- [ ] 7. Spotify integration
- [ ] 8. Song history and persistence
- [ ] 9. Music diagnostics and debug export hooks
- [ ] 10. Utility/admin commands
- [ ] 11. UFC events module
- [ ] 12. Soundboard module
- [ ] 13. Voice recording module
- [ ] 14. yt-dlp module
- [ ] 15. Optional AI chat module
- [ ] 16. Web panel
- [ ] 17. End-to-end verification

## Definition of “Feature Complete”

A full reimplementation is meaningfully complete when:

- [ ] startup works from config and env without manual code edits
- [ ] enabled cogs load cleanly
- [ ] music playback, queue handoff, skip, stop, and disconnect behavior work across multiple guild runs
- [ ] playlist and Spotify flows queue correctly without blocking the event loop
- [ ] debug logs and panel export capture enough state to diagnose failures
- [ ] admin/utility commands match the current surface area closely enough for existing users
- [ ] event scheduling, yt-dlp, soundboard, and recording flows all complete successfully
- [ ] the web panel reflects live state accurately
