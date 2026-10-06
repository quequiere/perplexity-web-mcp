import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, "../.playwright/profile");
// The fallback script (~/.hermes/scripts/pplx_grok_text.sh) and other ad-hoc
// node runs can leave Chromium holding the profile via a stale SingletonLock.
// Before launching, remove the lock if it points to a dead PID.
function clearStaleSingletonLock(): void {
  const lockPath = path.join(PROFILE_DIR, "SingletonLock");
  try {
    const target = fs.readlinkSync(lockPath); // e.g. "fem-3491572" or "hostname-PID"
    const m = target.match(/-(\d+)$/);
    if (m) {
      const pid = Number(m[1]);
      try {
        process.kill(pid, 0); // throws if not running
        return; // live owner — keep the lock
      } catch (e: any) {
        if (e?.code !== "ESRCH") return; // running or no permission — keep lock
      }
      console.error(`[perplexity-web-mcp] Removing stale SingletonLock (dead PID ${pid})`);
      fs.unlinkSync(lockPath);
    }
  } catch {
    // No lock, or not a symlink — nothing to do.
  }
}

function checkChromiumInstalled(): void {
  try {
    execSync("npx playwright install --dry-run chromium", { stdio: "ignore" });
  } catch {
    // dry-run not available in all versions, fall back to checking executablePath
  }
  try {
    chromium.executablePath();
  } catch {
    console.error(
      "[perplexity-web-mcp] Chromium is not installed.\n" +
      "Run: npx playwright install chromium"
    );
    process.exit(1);
  }
}

let context: BrowserContext | null = null;

export async function launchBrowser(): Promise<void> {
  checkChromiumInstalled();
  clearStaleSingletonLock();
  if (context) {
    await context.close();
    context = null;
  }

  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-position=0,0",
      "--no-focus-on-map",
    ],
  });
}

export async function ensureBrowser(): Promise<void> {
  if (!context) {
    await launchBrowser();
    return;
  }
  // Health check: relaunch if the persistent-context Chromium has died since
  // the last call (e.g. an external cleanup killed it). Verified empirically:
  // browser() stays non-null after close; only isConnected() flips to false.
  try {
    const b = context.browser();
    if (!b || !b.isConnected()) await launchBrowser();
  } catch {
    await launchBrowser();
  }
}

export function getContext(): BrowserContext {
  if (!context) throw new Error("Browser not initialized. Call launchBrowser first.");
  return context;
}

export async function newSearchPage(): Promise<Page> {
  return getContext().newPage();
}

export async function getFirstPage(): Promise<Page> {
  const ctx = getContext();
  return ctx.pages()[0] ?? ctx.newPage();
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
}
