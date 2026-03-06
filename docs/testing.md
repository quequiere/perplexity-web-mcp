# Testing Guide

This guide walks you through the different ways to test `perplexity-web-mcp` locally before integrating it into your MCP client.

The browser always runs **visible** (non-headless) — this is required to pass Cloudflare's bot detection.

## Prerequisites

Make sure you have built the project first:

```bash
npm install
npm run build
```

---

## Test 1 — Anonymous search (quickest)

The fastest way to validate the search tool works — no login required.

```bash
# Linux / macOS
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"what is the MCP protocol"}}}' | node dist/index.js
```

```powershell
# Windows (PowerShell)
'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"what is the MCP protocol"}}}' | node dist/index.js
```

```bash
# Windows (Git Bash / MINGW64) — pipe stdin via file to avoid tty issues
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"what is the MCP protocol"}}}' > /tmp/mcp-test.json
node dist/index.js < /tmp/mcp-test.json
```

**Expected output** on stdout:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [{ "type": "text", "text": "The Model Context Protocol (MCP) is..." }]
  }
}
```

**Expected output** on stderr:

```
[perplexity-web-mcp] Starting (timeout=20000ms)...
[perplexity-web-mcp] Ready. Browser will launch on first tool call.
```

---

## Test 2 — Authentication via the `login` tool

Call the `login` tool to authenticate with a Perplexity account. The browser opens on demand — no `--auth` flag needed.

```bash
# Linux / macOS
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"login","arguments":{}}}' | node dist/index.js
```

```bash
# Windows (Git Bash / MINGW64)
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"login","arguments":{}}}' > /tmp/mcp-login.json
node dist/index.js < /tmp/mcp-login.json
```

**If already authenticated**, expected stdout:

```json
{ "result": { "content": [{ "type": "text", "text": "Already authenticated on Perplexity.ai." }] } }
```

**If not authenticated:**

1. A Chromium window opens on `perplexity.ai`
2. Sign in with your Google account (or email)
3. Once logged in, the tool returns:

```json
{ "result": { "content": [{ "type": "text", "text": "Login successful. You are now authenticated on Perplexity.ai." }] } }
```

Your session is persisted in `.playwright/profile/` — you will not need to log in again.

> **Timeout:** If you do not log in within 5 minutes, the server will exit with an error.

---

## Test 3 — Integration with Claude Code

Add the following to your Claude Code MCP settings (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "perplexity-web": {
      "command": "node",
      "args": ["C:/src/perplexity-web-mcp/dist/index.js"]
    }
  }
}
```

Then:
- Ask Claude: **"Search for TypeScript best practices using perplexity"** (anonymous)
- Or ask Claude: **"Login to Perplexity"** to authenticate before searching

---

## CLI flags reference

| Flag | Default | Description |
|------|---------|-------------|
| `--timeout=N` | `20` | Max seconds to wait for Perplexity to answer |

Example with a longer timeout for slow connections:

```bash
node dist/index.js --timeout=40
```

---

## Debug logs

The server prints progress to stderr at each step:

```
[perplexity-web-mcp] Starting (timeout=20000ms)...
[perplexity-web-mcp] Ready. Browser will launch on first tool call.
[perplexity-web-mcp] Search: "what is TypeScript" (timeout: 20000ms)
[perplexity-web-mcp] Navigating to perplexity.ai...
[perplexity-web-mcp] Typing query...
[perplexity-web-mcp] Waiting for answer to complete...
[perplexity-web-mcp] Extracting answer from DOM...
[perplexity-web-mcp] Done. Answer length: 1243 chars, sources: 5
```

---

## Troubleshooting

**`button:has-text("sources")` timeout**

Perplexity did not finish generating the answer within the timeout, or the selector changed. Try increasing the timeout with `--timeout=40`. If the problem persists, inspect the Chromium window and update the selector in `src/search.ts`.

**Chromium not found**

Run `npx playwright install chromium` manually. This should have been done automatically via the `postinstall` script, but may fail in restricted environments.
