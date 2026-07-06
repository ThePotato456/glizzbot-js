# GlizzBot Functionality

This document is the working implementation tracker for the GlizzBot rewrite. It is intentionally organized as stepwise operations by feature set so the remaining work can be audited, delegated, or completed in order without reinterpreting the whole project each time.

The tracking below preserves the current intent of the existing checklist while restructuring the file completely.

## Rewrite Snapshot

### Working in the current TypeScript rewrite

- config loading with defaults, env overrides, per-guild helpers, and runtime directory bootstrap
- custom Discord client runtime with command lifecycle logging and event-loop lag monitoring
- modular command registration
- working music playback with yt-dlp, ffmpeg, queue controls, playlist expansion, lazy per-track resolution, and one-track-ahead prefetch
- custom DAVE-capable voice transport for Discord voice channels that require E2EE/DAVE
- GlizzBot-style simple music embeds for visible music responses
- local web panel status/export endpoints
- legacy `song_history` SQLite compatibility, import, and active history writes

### Still partial or intentionally unfinished in the current rewrite

- Spotify albums/playlists and richer Spotify helpers
- history browsing and random-from-history commands beyond `playrandom`
- audio caching or download-to-local playback path
- transcript/export parity with the Python utility and admin surface
- full event scheduling parity
- voice recording pipeline
- the old soundboard behavior, which has intentionally been retired in favor of `play`

## Legacy Scope Summary

The original Python bot covers:

- bootstrapping, config, and runtime logging
- cog loading and runtime extension management
- music playback, queueing, source resolution, playlists, Spotify, song history, and diagnostics
- utility and admin commands
- UFC event discovery and Discord scheduled-event management
- soundboard-style local clip playback
- owner-only voice recording
- optional local AI chat
- yt-dlp-based direct download workflows
- a local web panel and debug export surface

## 1. Core Runtime

Files:

- [bot.py](C:/Users/User/Documents/vscode_projects/GlizzBot/bot.py)
- [app_config.py](C:/Users/User/Documents/vscode_projects/GlizzBot/app_config.py)

Goal:

- define the entrypoint, runtime lifecycle, logging, guild bootstrap behavior, and process-level safety net for the bot

### 1.1 Entrypoint, Environment, and Startup

- [x] Step 1.1.1 Create a central config module with defaults, validation, and env overrides.
- [x] Step 1.1.2 Build a custom bot subclass instead of scattering startup logic across modules.
- [x] Step 1.1.3 Add a custom help command and remove the default one.

### 1.2 Runtime Logging and Observability

- [x] Step 1.2.1 Add runtime logging for both Discord internals and bot-specific events.
- [x] Step 1.2.2 Add command lifecycle logging (`start`, `complete`, `error`).
- [x] Step 1.2.3 Add a shared in-memory bot log buffer for the web panel and export surface.

### 1.3 Event Loop and Failure Handling

- [x] Step 1.3.1 Add an event loop lag monitor and expose the measured lag to the rest of the app.
- [ ] Step 1.3.2 Load cogs dynamically from `cogs/`, honoring `ENABLED_COGS`.

## 2. Configuration Model

Files:

- [app_config.py](C:/Users/User/Documents/vscode_projects/GlizzBot/app_config.py)
- [config/config.example.json](C:/Users/User/Documents/vscode_projects/GlizzBot/config/config.example.json)
- [config/config.json](C:/Users/User/Documents/vscode_projects/GlizzBot/config/config.json)

Goal:

- model global config, per-guild config, secret overrides, and mutable persisted settings in a way that survives restarts and host moves

### 2.1 Schema and Defaults

- [x] Step 2.1.1 Define a single authoritative config schema with nested defaults.
- [x] Step 2.1.2 Split global config from per-guild config.
- [x] Step 2.1.3 Implement safe merging of defaults with user config.

### 2.2 Secret Overrides and Validation

- [x] Step 2.2.1 Implement secret override support from environment variables.
- [x] Step 2.2.2 Validate required runtime fields before boot.

### 2.3 Guild Configuration Helpers

- [x] Step 2.3.1 Add helper functions for reading and mutating per-guild config.

## 3. Cog and Runtime Management

Files:

- [cogs/manager.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/manager.py)

Goal:

- support owner-only runtime extension management without letting the operator brick the manager surface accidentally

### 3.1 Owner-Only Extension Control

- [ ] Step 3.1.1 Add an owner-only cog manager.
- [ ] Step 3.1.2 Normalize cog names to a canonical `cogs.<name>` format.
- [ ] Step 3.1.3 Support `load`, `unload`, `reload`, `reloadall`, and `listcogs`.

### 3.2 Runtime Safety

- [ ] Step 3.2.1 Show action status in ephemeral or temporary embeds.
- [ ] Step 3.2.2 Protect against unloading the manager itself.

## 4. Music System

Files:

- [cogs/music.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/music.py)
- [utils.py](C:/Users/User/Documents/vscode_projects/GlizzBot/utils.py)
- [config/database.db](C:/Users/User/Documents/vscode_projects/GlizzBot/config/database.db)

Goal:

- reimplement the largest subsystem in the project: voice join, queue management, source resolution, playback handoff, history, and diagnostics

## 4A. Music Playback and Queueing

What this feature set is responsible for:

- joining the requester's voice channel
- resolving a query into a playable source
- playing a single track or queueing it
- advancing to the next track through the playback completion path
- keeping per-guild queue state
- disconnecting after an idle delay when configured to leave
- treating paused audio as active playback
- serializing queue advancement safely

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

### 4A.1 Guild Music State

- [ ] Step 4A.1.1 Build a per-guild music state object containing queue, voice client, current track, retry/debug state, and playback lock.

### 4A.2 Voice Connection Helpers

- [ ] Step 4A.2.1 Add helpers for connecting to the caller's voice channel and resolving the active voice client.

### 4A.3 Playback Entry Commands

- [ ] Step 4A.3.1 Implement `play` for search queries, direct URLs, YouTube playlists, and Spotify URLs.
- [ ] Step 4A.3.2 Add `skip`, `stop`, `clear`, `insert`, `shuffle`, and `remove`.
- [ ] Step 4A.3.3 Add `queue` and `nowplaying` embeds.
- [ ] Step 4A.3.4 Add a toggle for whether timing or debug output is shown.

### 4A.4 Queue Handoff and Idle Leave

- [ ] Step 4A.4.1 Implement a serialized `play_next_async()` queue handoff path.
- [ ] Step 4A.4.2 Use the Discord `after` callback to schedule async queue advancement safely onto the event loop.
- [ ] Step 4A.4.3 Implement delayed disconnect when queue is empty and `should_leave` is enabled.

## 4B. Lazy Queue Resolution and Prefetching

What this feature set is responsible for:

- queueing URL placeholders for playlists and large Spotify collections
- resolving stream metadata only when a track approaches playback
- prefetching the next queued item in the background
- skipping unresolved or unavailable items instead of stalling the queue

### 4B.1 Lightweight Queue Items

- [ ] Step 4B.1.1 Introduce a lightweight queue item format for unresolved URL entries.

### 4B.2 Resolve-On-Playback Flow

- [ ] Step 4B.2.1 Resolve queued URL items immediately before playback.
- [ ] Step 4B.2.2 Skip broken queued items and continue advancing.

### 4B.3 Background Prefetch

- [ ] Step 4B.3.1 Add one-track-ahead background prefetching.
- [ ] Step 4B.3.2 Ensure prefetch failures do not crash playback.

## 4C. Audio Caching

What this feature set is responsible for:

- downloading audio for playback into a local cache path
- preferring cached local audio when available
- marking cached items as local so FFmpeg can use file input directly
- logging cache start, success, fallback, and reuse behavior in debug mode

### 4C.1 Cache and Download Layer

- [ ] Step 4C.1.1 Add a helper to download playable audio to a local file.
- [ ] Step 4C.1.2 Reuse a local file if `stream_url` already points to an existing file.
- [ ] Step 4C.1.3 Mark cached tracks with metadata like `_local_audio`.

### 4C.2 Playback Preference and Diagnostics

- [ ] Step 4C.2.1 Use local files for playback when available.
- [ ] Step 4C.2.2 Log cache outcomes for diagnostics.

## 4D. Search and Source Resolution

What this feature set is responsible for:

- accepting direct YouTube, YouTube Music, SoundCloud, and Spotify URLs
- accepting plain-text search terms and resolving them to YouTube matches
- distinguishing playlists from single items
- falling back to yt-dlp or download methods when extraction fails

### 4D.1 Source Classification and Normalization

- [ ] Step 4D.1.1 Build a source resolver that classifies query types.
- [ ] Step 4D.1.2 Normalize YouTube and Spotify URLs before processing.

### 4D.2 Lookup and Metadata Extraction

- [ ] Step 4D.2.1 Add YouTube search fallback for plain-text queries.
- [ ] Step 4D.2.2 Add track metadata extraction with a fallback download path.
- [ ] Step 4D.2.3 Keep source resolution async or move blocking work off the event loop.

## 4E. Spotify Integration

What this feature set is responsible for:

- supporting Spotify track, album, and playlist URLs
- looking up Spotify metadata through Spotipy
- converting Spotify tracks into YouTube matches
- queueing albums and playlists as lazy YouTube-backed entries
- supporting background matching for large collections
- exposing Spotify info commands and feature toggles

Key commands:

- `spotify_to_youtube` / `syt`
- `salbum`
- `splaylist`
- `sinfo`

### 4E.1 Client Initialization and Feature Gates

- [ ] Step 4E.1.1 Add Spotify client initialization from config or env credentials.
- [ ] Step 4E.1.2 Add feature gates for Spotify tracks, playlists, albums, and wrapper commands.

### 4E.2 Track and Collection Conversion

- [ ] Step 4E.2.1 Resolve Spotify tracks to YouTube URLs using search heuristics.
- [ ] Step 4E.2.2 Implement album and playlist collection fetching with pagination.
- [ ] Step 4E.2.3 Queue Spotify collections as lazy YouTube entries.

### 4E.3 Background Collection Processing and Info Commands

- [ ] Step 4E.3.1 Add background processing for remaining collection items.
- [ ] Step 4E.3.2 Add a metadata info command for track, album, or playlist inspection.

## 4F. Song History and Persistence

What this feature set is responsible for:

- storing songs in SQLite
- storing song history and requester information
- supporting random and history-based playback features
- backfilling legacy history user IDs on startup

Likely user-facing commands:

- `songhistory`
- `playrandom`
- `songlink`

### 4F.1 Schema and Writes

- [x] Step 4F.1.1 Create SQLite schema and migrations for songs and history.
- [x] Step 4F.1.2 Save tracks when they are queued or successfully played, depending on flow.
- [x] Step 4F.1.3 Record requester identity with the history entry.

### 4F.2 History-Powered Commands

- [x] Step 4F.2.1 Add random replay helpers (`playrandom`) backed by imported song history.
- [ ] Step 4F.2.2 Add history browsing and lookup helpers (`songhistory`, `songlink`).

### 4F.3 Legacy Maintenance

- [x] Step 4F.3.1 Add one-time maintenance, backfill, or import support for legacy rows or DB files.

## 4G. Music Diagnostics

What this feature set is responsible for:

- capturing detailed playback debug events when debug mode is enabled
- logging playback start and end, queue advancement, skip and stop reasons, cache events, and voice state
- recording incident snapshots for export
- exposing `markaudio` for user-driven debug bookmarks
- tracking playback timing so exports can show expected vs elapsed duration

Key command:

- `markaudio`

### 4G.1 Playback and State Logging

- [x] Step 4G.1.1 Add structured debug logging around all playback state transitions.
- [x] Step 4G.1.2 Add explicit stop reasons for manual `skip` and `stop`.

### 4G.2 Incident Tracking and Timing

- [x] Step 4G.2.1 Record passive incident snapshots that can be exported later.
- [x] Step 4G.2.2 Track timing fields like `started_at`, `elapsed`, and expected duration.

### 4G.3 Manual User Markers

- [ ] Step 4G.3.1 Add a manual "mark current audio state" command for user-triggered debug bookmarks.

## 5. Utility and Admin Commands

Files:

- [cogs/commands.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/commands.py)

Goal:

- port the general utility surface around moderation, exports, role pinging, and convenience formatting

Commands seen in the legacy code:

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

### 5.1 General Utility Surface

- [ ] Step 5.1.1 Add a general utility cog for non-music commands.
- [ ] Step 5.1.2 Add curve-text conversion and configured role-ping support.
- [ ] Step 5.1.3 Honor per-guild blocked user settings where applicable.

### 5.2 Voice and Guild Management

- [ ] Step 5.2.1 Implement voice move helpers using Discord member and channel objects.
- [ ] Step 5.2.2 Add owner-only guild and invite management commands.

### 5.3 Exports and Search Helpers

- [ ] Step 5.3.1 Add transcript export to HTML attachments.
- [ ] Step 5.3.2 Add simple Google search output formatting.

## 6. UFC Events Module

Files:

- [cogs/events.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/events.py)

Goal:

- fetch UFC event data, normalize it, preview it in Discord, and optionally mirror it into Discord scheduled events

Commands:

- `ufcevents` / `ufc`
- `schedule` / `scheduleufc`
- `events`
- `clearufc` / `clearufcevents`

### 6.1 External Event Modeling and Fetching

- [ ] Step 6.1.1 Add a data model for external event records.
- [ ] Step 6.1.2 Fetch ESPN UFC scoreboard data with date-window filtering.
- [ ] Step 6.1.3 Parse and normalize event names, times, and location data.

### 6.2 Discord Presentation and Scheduling

- [ ] Step 6.2.1 Build preview embeds for upcoming events.
- [ ] Step 6.2.2 Create Discord scheduled events with optional image support.
- [ ] Step 6.2.3 Detect and skip already-scheduled duplicate UFC events.

### 6.3 Scheduling Maintenance Commands

- [ ] Step 6.3.1 Add list and clear commands for scheduled UFC events.
- [ ] Step 6.3.2 Add cooldowns and permission checks for scheduler actions.

## 7. Soundboard Module

Files:

- [cogs/sound.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/sound.py)
- `audio/sounds.json` at runtime

Goal:

- support named local clip playback for the short-sound workflow used by the original bot

Commands:

- `playsound`
- `sounds`

### 7.1 Runtime Sound Assets

- [ ] Step 7.1.1 Create an `audio/` directory and `sounds.json` manifest.
- [ ] Step 7.1.2 Load sound metadata at startup.

### 7.2 Playback and Disconnect

- [ ] Step 7.2.1 Implement local FFmpeg playback for named clips.
- [ ] Step 7.2.2 Auto-disconnect after the clip finishes.

### 7.3 Listing and Info

- [ ] Step 7.3.1 Add a sound listing or info command.

## 8. Voice Recording Module

Files:

- [cogs/record.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/record.py)

Goal:

- support owner-only recording for a target voice channel and return resulting files to Discord

Commands:

- `vcrecord`
- `stoprecord`

### 8.1 Command and Permission Layer

- [ ] Step 8.1.1 Add owner-only record start and stop commands.
- [ ] Step 8.1.2 Connect to a target voice channel or fall back to the caller's channel.

### 8.2 Recording Lifecycle

- [ ] Step 8.2.1 Start a recording sink and persist active recording state per guild.
- [ ] Step 8.2.2 Save output files under a recordings directory with timestamped filenames.
- [ ] Step 8.2.3 Send resulting files and metadata back into the text channel.
- [ ] Step 8.2.4 Disconnect cleanly when recording ends.

## 9. Optional AI Chat Module

Files:

- [cogs/chatgpt.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/chatgpt.py)

Goal:

- support per-guild conversation state, persona switching, chat history inspection, and local-model interaction

Commands:

- `changepersona`
- `reset`
- `convo`
- `chat`
- `tokens`
- `personas`

### 9.1 State and Persona Management

- [ ] Step 9.1.1 Add a per-guild conversation state store.
- [ ] Step 9.1.2 Add persona definitions and default system prompt handling.

### 9.2 Model Integration and Commands

- [ ] Step 9.2.1 Connect to a local LLM backend such as Ollama.
- [ ] Step 9.2.2 Implement chat, reset, persona switch, and conversation inspection commands.
- [ ] Step 9.2.3 Add lightweight token estimation for visibility.

## 10. yt-dlp Download Module

Files:

- [cogs/ytdlp.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/ytdlp.py)

Goal:

- support explicit media download workflows, upload handoff, and optional automatic URL processing outside the live music playback path

Commands:

- `dl` / `ytdlp` / `ytdl` / `download`
- `dlauto` / `ytdlpauto` / `ydlauto` / `autodl`

### 10.1 Download and Staging Workflow

- [ ] Step 10.1.1 Add a yt-dlp integration layer with configurable output modes.
- [ ] Step 10.1.2 Stage downloads in a local working directory.

### 10.2 Upload and Public URL Return

- [ ] Step 10.2.1 Upload completed files to a remote server over SCP.
- [ ] Step 10.2.2 Return a public URL instead of keeping large files locally.

### 10.3 Auto-Download Flow

- [ ] Step 10.3.1 Persist the set of users with auto-download enabled.
- [ ] Step 10.3.2 Add an `on_message` flow for automatic URL detection.
- [ ] Step 10.3.3 Avoid recursive handling of already-public uploaded links.
- [ ] Step 10.3.4 Serialize downloads per user to avoid overlapping jobs.

## 11. Web Panel and Debug Export

Files:

- [cogs/web_panel.py](C:/Users/User/Documents/vscode_projects/GlizzBot/cogs/web_panel.py)

Goal:

- provide a read-only local HTTP dashboard and a richer machine-readable debug export surface

Endpoints and functionality seen in the legacy code:

- panel HTML UI
- `/api/status`
- `/api/export`

### 11.1 HTTP Server and Read-Only UI

- [ ] Step 11.1.1 Add a lightweight HTTP server separate from Discord event handling.
- [ ] Step 11.1.2 Serve a simple read-only dashboard page.
- [ ] Step 11.1.3 Keep the panel read-only.

### 11.2 Status API and Auth

- [ ] Step 11.2.1 Add a JSON status API with runtime metrics and music state.
- [ ] Step 11.2.2 Add optional header or query token auth for the panel.

### 11.3 Debug Export Surface

- [ ] Step 11.3.1 Add a downloadable debug export endpoint.
- [ ] Step 11.3.2 Include bot logs, Discord logs, music diagnostics, tracebacks, thread stacks, and task snapshots in the export.

## 12. Shared Utilities

Files:

- [utils.py](C:/Users/User/Documents/vscode_projects/GlizzBot/utils.py)

Goal:

- centralize common helpers without turning the utility layer into a dumping ground

Likely shared responsibilities:

- embed helpers
- guild config lookups
- curve-text formatting
- YouTube search and extraction helpers
- audio length and time helpers
- database helpers
- debug message helpers

### 12.1 Shared Message and Formatting Helpers

- [ ] Step 12.1.1 Move repeated embed and message helpers into a shared utility module.
- [ ] Step 12.1.2 Centralize formatting helpers such as durations and curve-font output.

### 12.2 Thin Config and Media Helpers

- [ ] Step 12.2.1 Centralize config accessors there only if they stay thin.
- [ ] Step 12.2.2 Centralize media helper functions used by music, sound, and yt-dlp.

## 13. Data and Runtime Directories

Runtime directories and files used by the bot:

- `config/config.json`
- `config/database.db`
- `downloads/`
- `temp/ytdlp/`
- `audio/`
- `audio/sounds.json`
- `recordings/`
- `discord.log`

Goal:

- define runtime storage consistently and keep persistent data separate from disposable staging areas

### 13.1 Central Runtime Path Definition

- [ ] Step 13.1.1 Define all runtime directories in one place.
- [ ] Step 13.1.2 Ensure required directories are created automatically.

### 13.2 Persistence vs Temporary Staging

- [ ] Step 13.2.1 Separate persistent data from temporary staging data.
- [ ] Step 13.2.2 Document cleanup expectations for downloads, recordings, and staged yt-dlp files.

## 14. Suggested Reimplementation Order

Use this as the top-level progress tracker.

- [ ] Step 14.1 Core boot, config, and logging
- [ ] Step 14.2 Shared utilities and embeds
- [ ] Step 14.3 Cog loader and manager
- [ ] Step 14.4 Music core playback and queue state
- [ ] Step 14.5 Music source resolution and caching
- [ ] Step 14.6 Music playlists, lazy queue items, and prefetch
- [ ] Step 14.7 Spotify integration
- [ ] Step 14.8 Song history and persistence
- [ ] Step 14.9 Music diagnostics and debug export hooks
- [ ] Step 14.10 Utility and admin commands
- [ ] Step 14.11 UFC events module
- [ ] Step 14.12 Soundboard module
- [ ] Step 14.13 Voice recording module
- [ ] Step 14.14 yt-dlp download module
- [ ] Step 14.15 Optional AI chat module
- [ ] Step 14.16 Web panel
- [ ] Step 14.17 End-to-end verification

## 15. Definition of Feature Complete

A full reimplementation is meaningfully complete when:

- [ ] Step 15.1 Startup works from config and env without manual code edits.
- [ ] Step 15.2 Enabled cogs load cleanly.
- [ ] Step 15.3 Music playback, queue handoff, skip, stop, and disconnect behavior work across multiple guild runs.
- [ ] Step 15.4 Playlist and Spotify flows queue correctly without blocking the event loop.
- [ ] Step 15.5 Debug logs and panel export capture enough state to diagnose failures.
- [ ] Step 15.6 Admin and utility commands match the current surface area closely enough for existing users.
- [ ] Step 15.7 Event scheduling, yt-dlp, soundboard, and recording flows all complete successfully.
- [ ] Step 15.8 The web panel reflects live state accurately.
