# Changelog

All notable changes to SnipSense are documented here.

## [0.1.0] - 2026-11-13

### Added

- Auto-explain on text selection with debounce and cancellation.
- Inline one-sentence gloss at the end of the selection.
- Streaming side-panel dictionary card with gist and key points.
- Follow-up questions and quick actions (simpler / example / why).
- DeepSeek, OpenAI, SiliconFlow, Ollama and custom OpenAI-compatible providers.
- API key storage in VS Code `SecretStorage`.
- Local explanation cache with LRU eviction, keyed by code hash.
- Manual trigger via `Alt+Q`, context menu and Command Palette.
- Pin, copy, open-in-editor, status bar entry and cache clearing.
- Restricted Mode handling: auto-explain is paused in untrusted workspaces.
- Unit tests for prompts, SSE, parser, cache, endpoint, selection and client.
- English README and Chinese-first UI.
