// Inject Perplexity session cookie into the MCP persistent profile.
// Usage: node inject-cookie.mjs ~/.pplx-cookie
import { chromium } from "playwright";
import { readFileSync, statSync } from "fs";

const COOKIE_FILE = process.argv[2] || "/home/paleta/.pplx-cookie";
const PROFILE = "/home/paleta/pplx-mcp/.playwright/profile";

const raw = readFileSync(COOKIE_FILE, "utf8").trim();
if (!raw || raw.length < 20) {
  console.error("Cookie file empty or too short. Aborting.");
  process.exit(1);
}
// Formats accepted:
//  - "value" (single line)
//  - "name\nvalue"
//  - multi-line block: name line, then N lines of `i:"segment"` —
//    the value is the segments joined with "." (empty segment = "..")
function parseBlocks(raw) {
  const cookies = [];
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  let current = null;
  for (const line of lines) {
    const m = line.match(/^(\d+):"(.*)"$/);
    if (m && current) {
      current.segments[Number(m[1])] = m[2];
    } else if (line.startsWith("__Secure-")) {
      if (current) cookies.push(current);
      current = { name: line, segments: [] };
    } else if (current) {
      // continuation of a plain value
      current.segments[0] = (current.segments[0] || "") + line;
    }
  }
  if (current) cookies.push(current);
  return cookies.map(c => ({
    name: c.name,
    value: c.segments.length > 1 ? c.segments.join(".") : (c.segments[0] || ""),
  }));
}

const parsed = parseBlocks(raw);
if (parsed.length === 0 || parsed.some(c => !c.value || c.value.length < 20)) {
  console.error("Could not parse cookie file. Aborting.");
  process.exit(1);
}
for (const c of parsed) console.log(`Parsed cookie: ${c.name} (value length: ${c.value.length})`);

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1280, height: 800 },
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());

await ctx.addCookies(
  parsed.map(c => ({
    name: c.name,
    value: c.value,
    domain: ".perplexity.ai",
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  })),
);

// Verify
await page.goto("https://www.perplexity.ai/", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.waitForTimeout(5000);
const session = await page.evaluate(async () => {
  try {
    const r = await fetch("https://www.perplexity.ai/api/auth/session?version=2.18&source=default", { credentials: "include" });
    return await r.text();
  } catch (e) { return "ERR " + e.message; }
});
console.log("Session response: " + session.slice(0, 800));

try {
  const sess = JSON.parse(session);
  if (sess?.user?.id) {
    console.log(`\nSUCCESS: logged in as ${sess.user.email ?? sess.user.id}`);
  } else {
    console.log("\nFAILED: no user in session response.");
  }
} catch {
  console.log("\nFAILED: non-JSON session response (cookie invalid or expired?)");
}

await ctx.close();
