import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, "../.playwright/profile");

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
const CDP_ENDPOINT = process.env.PPLX_CDP_ENDPOINT ?? "http://localhost:9222";

function isClosedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /closed|Target page/i.test(msg);
}

export async function launchBrowser(): Promise<void> {
  checkChromiumInstalled();
  await closeBrowser();

  try {
    const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
    context = browser.contexts()[0] ?? (await browser.newContext());
    console.error(`[perplexity-web-mcp] Connected to persistent browser at ${CDP_ENDPOINT}`);
  } catch {
    console.error(`[perplexity-web-mcp] No persistent browser at ${CDP_ENDPOINT}; launching own instance.`);
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
}

/**
 * True only if a context exists AND its underlying browser is still connected.
 * A stale `context` after the browser dies is what used to wedge the MCP —
 * `ensureBrowser()` saw it as non-null and never relaunched, so every
 * `newPage()` threw "Target page, context or browser has been closed".
 */
async function isAlive(): Promise<boolean> {
  if (!context) return false;
  try {
    context.pages();
    return true;
  } catch {
    return false;
  }
}

export async function ensureBrowser(): Promise<void> {
  if (await isAlive()) return;
  context = null;
  await launchBrowser();
}

export function getContext(): BrowserContext {
  if (!context) throw new Error("Browser not initialized. Call launchBrowser first.");
  return context;
}

/** Runs `fn`, relaunching once if the browser died between calls. */
async function withRetry<T>(fn: (ctx: BrowserContext) => Promise<T>): Promise<T> {
  try {
    return await fn(getContext());
  } catch (err) {
    if (!isClosedError(err)) throw err;
    context = null;
    await launchBrowser();
    return await fn(getContext());
  }
}

export async function newSearchPage(): Promise<Page> {
  return withRetry((ctx) => ctx.newPage());
}

export async function getFirstPage(): Promise<Page> {
  return withRetry(async (ctx) => {
    const pages = ctx.pages();
    return pages[0] ?? (await ctx.newPage());
  });
}

export async function closeBrowser(): Promise<void> {
  if (context) {
    try {
      await context.close();
    } catch {
      // already closed
    }
    context = null;
  }
}
