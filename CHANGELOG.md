# Changelog

All notable changes to SnipSense are documented here.

## [0.3.0] - 2026-11-13

### Added

- Token-free static `DefinitionProvider` for **Ctrl+click / F12**.
- Jump across files for local declarations, imported functions/classes/types, aliases and namespace members (`ns.foo`).
- Jump directly from an import path string to the target file.
- Python absolute imports resolve against the current file directory first, so `ViT.py` + `from layer import PPEmb` finds the adjacent `layer.py`.
- `SnipSense: 跳转到定义（无 AI）` command and `Ctrl+Alt+J` binding.
- `quickJump` setting.
- Local-to-exported binding metadata (`add as plus`, default imports, namespace imports, `require`).
- 9 new unit tests (76 total) and integration coverage for a cursor-on-call jump to `math.ts`, both with the language server and with built-ins disabled (`SNIPSENSE_DISABLE_BUILTINS=1`).

### Changed

- The static definition provider first asks the language server; it only returns a fallback when the language server has no definition. This avoids duplicate Ctrl+click results in VS Code while keeping the fallback for Cursor/languages where the server has no answer.
- No AI request is made for navigation.

## [0.2.0] - 2026-11-13

### Added

- Cross-file dependency analysis for TS/JS, Python and a generic fallback.
- Import resolution for relative paths, common `@/` / `~/` aliases, Python modules and Java package paths.
- Definition excerpts for imported symbols actually used by the selection.
- Reference-provider call sites for exported/imported symbols.
- A “Related” card section with clickable dependency files and real usage sites.
- `**依赖关系**` / `**怎么用**` sections in the LLM prompt when a graph is available.
- Bounded graph context in follow-up questions.
- Settings: `multiFile`, `maxRelatedFiles`, `maxUsages`.
- Graph-aware cache keys and graph metadata in cache entries.
- 18 new unit tests; integration test now verifies cross-file context reaches the model.

### Changed

- Default `maxTokens` increased from 520 to 620 for dependency explanations.
- Cache format bumped to `snipsense.cache.v2`.
- Privacy documentation now covers related-file excerpts and call-site snippets.

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
