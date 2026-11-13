# Security

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

https://github.com/LuYuan-Zjyy/snipsense/security/advisories/new

Do not open a public issue for a vulnerability. Please include a minimal reproduction and the affected version.

## Design notes

- API keys are stored in VS Code `SecretStorage`, never in `settings.json`.
- Selected code and nearby context are sent only to the endpoint the user configures.
- Provider, endpoint, model and context-size settings are `application` scoped so a workspace cannot redirect code to another endpoint.
- Auto-explain is disabled in untrusted workspaces until the user manually triggers an explanation.
- The cache stores explanation text and a SHA-256 key, not source code.
- Model output is rendered through DOMPurify with a restrictive Content Security Policy.
- External links from model output are restricted to `http:` and `https:`.

## Supported versions

Security fixes are applied to the latest release on the `main` branch.
