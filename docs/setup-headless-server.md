# From-scratch setup on a fresh headless server

Complete, self-contained guide to get this MCP server working on a new
machine (verified 2026-09-12 on Ubuntu 24.04, user `paleta`, no sudo).
Everything here is reproducible without prior context.

## What this gives you

MCP tools `search` / `search_advanced` (with optional `model`) backed by a
logged-in Perplexity Pro session in a real (non-headless) Chromium under Xvfb.

## 1. Xvfb virtual display (no root)

Cloudflare Turnstile blocks headless browsers specifically — the browser must
run with `headless: false`, which needs a display the server doesn't have.

```bash
# without root: download and extract the .deb
mkdir -p ~/xvfb-root && cd /tmp
apt-get download xvfb
dpkg -x xvfb_*.deb ~/xvfb-root

# persistent systemd user service
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/xvfb-perplexity.service <<'EOF'
[Unit]
Description=Xvfb virtual display :99
After=network.target

[Service]
ExecStart=/home/PALETA/xvfb-root/usr/bin/Xvfb :99 -screen 0 1280x900x24 -nolisten tcp
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
EOF
sed -i 's|/home/PALETA/|/home/'$USER'/|' ~/.config/systemd/user/xvfb-perplexity.service
systemctl --user daemon-reload
systemctl --user enable --now xvfb-perplexity.service

# verify
DISPLAY=:99 xdpyinfo | head -1    # must print "name of display:    :99"
```

Requires `loginctl enable-linger <user>` (one-time; usually already set on
servers that run user services). Without linger the display dies when the
SSH session ends.

## 2. This server

```bash
git clone <this-repo> ~/pplx-mcp        # or copy the directory
cd ~/pplx-mcp && npm ci && npm run build
npx playwright install chromium
```

Playwright revision mismatch (`Executable doesn't exist .../chromium-XXXX/`):
symlink instead of re-downloading hundreds of MB:

```bash
ln -sfn ~/.cache/ms-playwright/chromium-<have> ~/.cache/ms-playwright/chromium-<want>
```

## 3. Login via session-cookie injection

The `login` tool opens a visible browser window — useless on a headless
server. Inject the session cookie instead:

1. On YOUR OWN machine, log in to perplexity.ai (Firefox shown; Chromium
   equivalents similar).
2. F12 → **Storage** tab → Cookies → https://www.perplexity.ai
   (If the Storage tab is missing: devtools settings → enable Storage.)
3. Click the `__Secure-next-auth.session-token` row once — the detail panel
   opens on the right.
4. Click into the **Value** field, Ctrl+A, Ctrl+C — the WHOLE value.
   - Length is typically 700+ chars; if you see `...` in the middle, you
     copied a truncated display value — redo it from the detail panel.
   - The Firefox JSON-viewer editor shows the value split into numbered
     segments (`0:"..."`, `1:""`, ...) — copy all of it; the injector
     joins segments with `.` automatically.
5. Save to a file on the server (never paste into chat):

```bash
# format: cookie name on one line, value (any format above) after
nano ~/pplx-mcp/perplexity.txt
```

6. Inject and verify:

```bash
cd ~/pplx-mcp
DISPLAY=:99 node inject-cookie.mjs perplexity.txt
# expect: "SUCCESS: logged in as <your email>"
```

The script accepts: bare value, `name\nvalue`, Firefox multi-segment paste
(`0:"seg"` lines), and multiple `__Secure-*` cookie blocks. Cookies live in
`.playwright/profile/` and survive restarts. Expiry ≈ 30 days — repeat this
step when searches start hitting the anonymous login wall.

## 4. Register in Hermes

Direct edits to `~/.hermes/config.yaml` are refused for agents — use the CLI:

```bash
hermes config set mcp_servers.perplexity.command "node"
hermes config set mcp_servers.perplexity.args '["/home/'$USER'/pplx-mcp/dist/index.js"]'
hermes config set mcp_servers.perplexity.env.DISPLAY ":99"
hermes config set mcp_servers.perplexity.timeout "300"
```

Tools appear as `mcp__perplexity__search` / `mcp__perplexity__search_advanced`
after the Hermes session restarts.

## 5. Verify end-to-end

```bash
# stdio smoke test without Hermes:
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' \
  | DISPLAY=:99 timeout 20 node dist/index.js | head -3
```

Then from Hermes: call `mcp__perplexity__search` with a trivial query.

## Operational notes (learned the hard way)

- **Profile lock**: only ONE Chromium may hold `.playwright/profile/`.
  If a test fails with `ProcessSingleton` / `SingletonLock: File exists`,
  kill the other instance first: `pkill -f "node.*pplx-mcp/dist"` (this kills
  the MCP servers; Hermes respawns them on next tool call) and remove
  `profile/Singleton*` if stale.
- **Stale MCP servers after a rebuild**: Hermes-spawned servers keep the OLD
  compiled code in memory and a stale browser context. After rebuilding,
  `pkill -f "node.*pplx-mcp/dist"` so the next tool call launches fresh ones.
- **Cookie renewal** (~monthly): step 3 above, then `pkill -f "node.*pplx-mcp/dist"`.
- **Never commit the cookie**: `perplexity.txt` is in `.gitignore`. Keep it
  that way.

## Maintenance history (what was fixed vs upstream)

- 2026-09 UI: answer extraction from `div[class*="thread-content"]`
  (old `[role="tabpanel"]` selector matched 11 empty Radix tabs) — commit 0faec91
- Completion detection: stabilization polling instead of "button with digits" — 0faec91
- Truncated answers: require stable answer text, not just the `Sources N`
  badge (badge appears mid-stream) — 2729133
- Model selection: real `mouse.click()` at coordinates (synthetic DOM click
  is ignored); trigger located by `#pplx-icon-chevron-down` icon — 11b150a
- Max-tier models excluded from `model` param (Pro account) — 4f93c16

- ask_with_file tool (file attachments via hidden composer input + chip-settled wait) — 801cc76
