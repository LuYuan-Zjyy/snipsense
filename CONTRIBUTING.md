# Contributing

Thanks for taking a look at SnipSense. Small, focused pull requests are very welcome.

## Development

```bash
npm install
npm run check
```

`npm run check` runs Prettier, TypeScript, ESLint, the Vitest suite and a production build. Please make sure it passes before opening a PR.

To try the extension:

1. Open this repository in VS Code or Cursor.
2. Press `F5` (or use the “Run SnipSense” launch configuration).
3. In the Extension Development Host, select some code and run **SnipSense: 设置模型与 API Key**.

A local Ollama instance is the easiest way to test without spending API credits:

```bash
ollama pull qwen2.5-coder:7b
ollama serve
```

Then select **Ollama（本地）** in the setup picker.

## Adding a provider

1. Add a `ProviderPreset` to `src/core/endpoint.ts`.
2. Add the enum value to `snipsense.provider` in `package.json`.
3. Add the provider to the setup quick pick automatically via `Object.keys(PROVIDERS)`.
4. Add an endpoint test if the provider needs special URL handling.
5. Mention it in both READMEs.

SnipSense intentionally targets OpenAI-compatible `/chat/completions` APIs. A provider that needs a different protocol should be a separate adapter, not a special case in the client.

## Changing prompts

Prompt changes affect output format parsing. Keep the `@@GIST@@` / `@@DETAIL@@` contract, or update `src/core/parser.ts` and `test/parser.test.ts` together.

Please include a before/after example in the PR description when changing tone or length.

## Code style

- TypeScript strict mode is on.
- Prettier and ESLint are enforced in CI.
- No telemetry, no hidden network calls, no source code in logs.
- New network or privacy-related settings should be `application` scoped.

## Reporting bugs

Please include:

- Cursor/VS Code version;
- SnipSense version;
- provider and model (do not include API keys);
- the exact error message from the **SnipSense** output channel.

Security issues should follow [SECURITY.md](SECURITY.md), not the public issue tracker.
