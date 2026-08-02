# Contributing to Sol InDesign MCP

Thank you for helping improve the bridge. The project is intentionally narrow: it connects Codex to Adobe InDesign through a local, authenticated UXP panel and a typed operation language.

## Before opening a change

- Read [AGENTS.md](AGENTS.md) and [SECURITY.md](SECURITY.md).
- Keep the supported architecture Windows-native: Codex STDIO -> Node MCP server -> authenticated loopback bridge -> InDesign UXP.
- Do not add arbitrary script execution, COM, ExtendScript, UI automation, remote endpoints, or unrestricted DOM access.
- Never commit pairing tokens, `.codex/config.toml`, exported documents, UDT state, logs, or private test material.

## Local checks

Use native Windows Node.js 22.22.3 and pnpm 11.13.0, then run:

```powershell
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm test:contract
pnpm build
```

For changes involving packaging, tokens, manifests, or the real host, also run the applicable commands documented in [README.md](README.md) and identify whether the evidence is mock/unit or real-host evidence.

## Pull requests

Describe the behavior change, security impact, tests run, and any host/version assumptions. Keep pull requests focused and update the protocol, tests, ADRs, and operator documentation together when the public behavior changes.

## Security reports

Do not open a public issue for a suspected credential, path-confinement, authentication, document-integrity, or data-loss vulnerability. Follow the private reporting guidance in [SECURITY.md](SECURITY.md).
