# perplexity-web-mcp

A lightweight MCP (Model Context Protocol) server that enables AI assistants to perform searches on [Perplexity.ai](https://www.perplexity.ai/) through browser automation. No official API key required.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue.svg)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-FastMCP-purple.svg)](https://github.com/punkpeye/fastmcp)

---

## Overview

`perplexity-web-mcp` bridges your AI assistant (Claude, Cursor, etc.) with Perplexity.ai by automating a real browser session via Playwright. It reads search results directly from the DOM — making it indistinguishable from a real user — and returns the answer text along with cited sources.

### Key features

- **Login once, search forever** — use the `login` tool to authenticate once; your session persists across restarts
- **Lazy browser launch** — the browser only opens on the first tool call, not at server startup
- **Always visible browser** — runs non-headless to bypass Cloudflare's bot detection (the window stays in the background during searches)
- **Sources included** — returns cited URLs alongside the answer text
- **Zero API key** — uses your existing Perplexity session (free or Pro)

---

## Installation

**Prerequisites:**
- [Node.js](https://nodejs.org/) >= 20
- Chromium (via Playwright): `npx playwright install chromium`

```bash
npx playwright install chromium
```

That's it — no clone, no build required.

---

## MCP configuration

### Claude Code

```bash
claude mcp add perplexity-web -- npx perplexity-web-mcp@latest
```

### Claude Desktop / other clients

Add to your MCP config (`.claude.json`):

```json
{
  "mcpServers": {
    "perplexity-web": {
      "command": "npx",
      "args": ["perplexity-web-mcp@latest"]
    }
  }
}
```

Optional flag: `--timeout=N` — max seconds to wait for an answer (default: `20`).

To authenticate, ask your AI client to call the `login` tool once. A Chromium window will open for you to sign in. Your session is persisted in `.playwright/profile/` and reused on future runs.

> **Why is a browser window visible?** Perplexity.ai uses Cloudflare Turnstile which blocks headless browsers. The window stays in the background and requires no interaction during normal use.

---

## MCP Tools

### `login`

Checks if you are authenticated on Perplexity.ai. If not, opens a browser window so you can log in.

**Parameters:** none

**Returns:** A status message — either `"Already authenticated"` or `"Login successful"` after the user completes the login flow.

> Your session is persisted in `.playwright/profile/` — you only need to call `login` once, or after a session expiry.

---

### `search`

Performs a search on Perplexity.ai and returns the answer with sources.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | `string` | Yes | The search query |
| `mode` | `string` | No | Search focus: `web` (default), `academic`, `news`, `youtube`, `reddit` |

**Returns:**

```
The capital of France is Paris...

Sources:
1. [Capital City of France - CountryReports](https://www.countryreports.org/...)
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  AI Client (Claude Desktop / Claude Code / Cursor / ...)        │
└────────────────────────┬────────────────────────────────────────┘
                         │  MCP stdio transport
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  perplexity-web-mcp  (FastMCP server)                           │
│                                                                 │
│  ┌─────────────────┐   ┌──────────────────────────────────────┐ │
│  │  CLI Arguments  │   │  MCP Tools                           │ │
│  │                 │   │                                      │ │
│  │  --timeout=N    │   │  login()                             │ │
│  │                 │   │    checks session, opens browser     │ │
│  │                 │   │    for login if not authenticated     │ │
│  │                 │   │                                      │ │
│  │                 │   │  search(query, mode?)                │ │
│  │                 │   │    returns: { answer, sources[] }    │ │
│  └────────┬────────┘   └──────────────┬───────────────────────┘ │
│           │                           │                         │
│           ▼                           ▼                         │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │  Browser Manager (Playwright, always visible)              │ │
│  │                                                            │ │
│  │  (browser launches lazily on first tool call)              │ │
│  │                                                            │ │
│  │  login()                                                   │ │
│  │    ├── GET /api/auth/session                               │ │
│  │    │    ├── active ──► "already authenticated"             │ │
│  │    │    └── none   ──► open browser, wait for user login   │ │
│  │                                                            │ │
│  │  search(query)                                             │ │
│  │    ├── open new tab, navigate to perplexity.ai             │ │
│  │    ├── type query in search box                            │ │
│  │    ├── wait for answer to complete (DOM signal)            │ │
│  │    ├── extract answer text from DOM                        │ │
│  │    ├── extract cited sources                               │ │
│  │    └── close tab                                           │ │
│  └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │   perplexity.ai      │
              │  (real browser req)  │
              └──────────────────────┘
```

---

## Development

```bash
# Run in development mode (hot reload)
npm run dev

# Build
npm run build

# Lint
npm run lint

# Type check
npm run typecheck
```

### Testing locally

See **[docs/testing.md](docs/testing.md)** for a full step-by-step guide covering:

- First-time authentication flow
- Persistent session verification
- Integration with Claude Code / Claude Desktop

---

## How it works

1. **Lazy browser launch** — the browser only opens when the first tool (`login` or `search`) is called, not at server startup.
2. **Login** — the `login` tool calls `GET /api/auth/session` to check the persisted session. If no session is found, a browser window opens and the server waits for the user to log in (up to 5 minutes).
3. **Search** — the `search` tool opens a new tab, navigates to `perplexity.ai`, types the query, and waits for Perplexity's answer to complete (detected via a DOM signal — the "N sources" button appearing).
4. **Extraction** — the answer and sources are extracted from the DOM and returned as text to the MCP client. The tab is then closed.
5. **Visible browser** — the browser always runs non-headless to pass Cloudflare's Turnstile bot detection, which reliably blocks headless Chromium regardless of stealth patches.

---

## Limitations

- Depends on Perplexity.ai's DOM structure — may break if they update their UI
- Rate limiting applies as per Perplexity's standard usage policies
- A visible browser window is always present (required to bypass Cloudflare Turnstile)
- Pro features (deeper research, Claude model) require an authenticated Pro account

---

## Contributing

Contributions are welcome! Please open an issue before submitting large PRs.

1. Fork the repo
2. Create a branch: `git checkout -b feat/my-feature`
3. Commit your changes
4. Open a Pull Request

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

## Disclaimer

This project automates a browser session for personal use. It is not affiliated with Perplexity AI, Inc. Use responsibly and in accordance with [Perplexity's Terms of Service](https://www.perplexity.com/hub/legal/terms-of-service).
