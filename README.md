# LLM Quota for Raycast

A small macOS menu-bar extension that shows Codex and Grok subscription quotas, reset times, and banked resets.

## Features

- Shows the remaining Codex primary quota directly in the menu bar.
- Shows Codex and Grok quota windows and their next reset times.
- Lists each banked reset with its expiry time.
- Highlights banked resets that expire within seven days, with a stronger warning inside 24 hours.
- Refreshes every five minutes and keeps the last successful result during temporary failures.

## Requirements

- macOS with [Raycast](https://www.raycast.com/) installed.
- The Codex CLI, signed in with `codex login`.
- The Grok CLI, signed in with `grok login`.

LLM Quota reuses those local CLI sessions. It does not ask for or store separate credentials.

## Use

1. Install dependencies with `npm install`.
2. Run `npm run dev` to import the development extension into Raycast.
3. Open **LLM Quota** once to add it to the menu bar and enable background refresh.

The menu-bar percentage always represents the primary Codex quota. Open the menu to see all available quota windows and banked resets.

## Data and privacy

- Codex data comes from the local Codex app server through `account/rateLimits/read`.
- Grok data comes from Grok's billing and remaining-resets endpoints using the session already managed by the Grok CLI.
- When a Grok access token expires, the extension asks the official Grok CLI to refresh it and retries once.
- Tokens are read only when making provider requests. They are never copied into Raycast storage, logs, or this repository.
- The extension can display banked resets but cannot redeem them.

## Limitations

Grok's consumer billing and reset interfaces are not documented public APIs and may change without notice. The integration is isolated in [`src/providers/grok.ts`](src/providers/grok.ts) so it can be updated independently.

This project is unofficial and is not affiliated with or endorsed by OpenAI, xAI, or Raycast.

## Development

```sh
npm install
npm run dev
```

Before submitting changes:

```sh
npm run lint
npm run build
```

The project is licensed under the [MIT License](LICENSE).
