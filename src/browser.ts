import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, "../.playwright/profile");

let context: BrowserContext | null = null;

export async function launchBrowser(): Promise<void> {
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
  if (!context) await launchBrowser();
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
