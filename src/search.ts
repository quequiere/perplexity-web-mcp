import type { Page } from "playwright";
import { newSearchPage } from "./browser.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
export const DEFAULT_TIMEOUT_MS = 20_000;

export interface Source {
  title: string;
  url: string;
}

export interface SearchResult {
  answer: string;
  sources: Source[];
}

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

export async function search(query: string, timeoutMs: number): Promise<SearchResult> {
  log(`Search: "${query}" (timeout: ${timeoutMs}ms)`);
  const page = await newSearchPage();

  try {
    log("Navigating to perplexity.ai...");
    await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });

    // Dismiss cookie banner and login overlay before interacting
    await dismissDialogs(page);

    log("Typing query...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const searchBox = page.locator("#ask-input").first();
    await searchBox.waitFor({ state: "visible", timeout: 10_000 }).catch(async (err) => {
      const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 5000));
      log(`DOM dump (first 5000 chars):\n${bodyHtml}`);
      throw err;
    });
    await searchBox.click();
    await searchBox.fill(query);
    await searchBox.press("Enter");

    log("Waiting for answer to complete...");
    await page.waitForSelector('button:has-text("sources")', { timeout: timeoutMs });

    // Dismiss signup dialog that may appear after search in anonymous mode
    await dismissDialogs(page);

    log("Extracting answer from DOM...");
    const [answer, sources] = await Promise.all([
      extractAnswer(page),
      extractSources(page),
    ]);

    log(`Done. Answer length: ${answer.length} chars, sources: ${sources.length}`);
    return { answer, sources };
  } finally {
    await page.close();
  }
}

async function dismissDialogs(page: Page): Promise<void> {
  // Cookie banner — "Cookies nécessaires" / "Necessary cookies"
  const cookieBtn = page.locator(
    'button:has-text("Cookies nécessaires"), button:has-text("Necessary cookies")'
  ).first();
  if (await cookieBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    log("Dismissing cookie banner...");
    await cookieBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Login/signup overlay — Perplexity renders this as a generic div, not a <dialog>.
  // The close button text is "Fermer" (FR) or has aria-label "Close" (EN).
  const closeBtn = page.locator(
    'button:has-text("Fermer"), button[aria-label="Close"], button[aria-label="Fermer"]'
  ).first();
  if (await closeBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    log("Dismissing login overlay...");
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function extractAnswer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]');
    if (!panel) return "";

    function getCleanText(el: Element): string {
      let text = "";
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent ?? "";
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const child = node as Element;
          const style = window.getComputedStyle(child);
          // Skip citation chips: pointer cursor + short text (e.g. "wikipedia+3")
          if (style.cursor === "pointer" && (child.textContent?.trim().length ?? 0) < 40) {
            continue;
          }
          text += getCleanText(child);
        }
      }
      return text;
    }

    const parts: string[] = [];
    const seen = new Set<string>();

    panel.querySelectorAll("h2, h3, p, li, pre code").forEach((el) => {
      if (el.tagName === "P" && el.closest("li")) return;
      if (el.tagName === "LI" && el.querySelector("li")) return;

      const tag = el.tagName.toLowerCase();
      const text = getCleanText(el).trim().replace(/\s+/g, " ");
      if (!text || seen.has(text)) return;
      seen.add(text);

      if (tag === "h2" || tag === "h3") {
        parts.push(`\n## ${text}\n`);
      } else if (tag === "code") {
        parts.push(`\`\`\`\n${text}\n\`\`\``);
      } else if (tag === "li") {
        parts.push(`- ${text}`);
      } else {
        parts.push(text);
      }
    });

    return parts.join("\n").trim();
  });
}

async function extractSources(page: Page): Promise<Source[]> {
  return page.evaluate(() => {
    const sources: { title: string; url: string }[] = [];
    const seen = new Set<string>();

    document.querySelectorAll<HTMLAnchorElement>('a[href^="http"]').forEach((link) => {
      const url = link.href;
      if (seen.has(url) || url.includes("perplexity.ai")) return;
      seen.add(url);
      const title = link.textContent?.trim() || new URL(url).hostname;
      sources.push({ title, url });
    });

    return sources.slice(0, 10);
  });
}
