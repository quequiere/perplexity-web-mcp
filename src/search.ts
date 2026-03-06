import type { Page } from "playwright";
import { newSearchPage } from "./browser.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
export const DEFAULT_TIMEOUT_MS = 20_000;

// Maps source name to its SVG icon id in the Perplexity UI — locale-independent
const SOURCE_ICON: Record<string, string> = {
  web:      "#pplx-icon-world",
  academic: "#pplx-icon-books",
  social:   "#pplx-icon-social",
};

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
  return runSearch(query, timeoutMs, null);
}

export async function searchWithSources(query: string, timeoutMs: number, sources: string[]): Promise<SearchResult> {
  log(`Search: "${query}" sources=[${sources.join(",")}] (timeout: ${timeoutMs}ms)`);
  return runSearch(query, timeoutMs, sources);
}

async function runSearch(query: string, timeoutMs: number, sources: string[] | null): Promise<SearchResult> {
  const page = await newSearchPage();

  try {
    log("Navigating to perplexity.ai...");
    await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
    await dismissDialogs(page);

    // Wait for the search input to be ready before any further interaction
    await page.locator("#ask-input").first().waitFor({ state: "visible", timeout: 10_000 });

    if (sources) {
      log(`Selecting sources: [${sources.join(", ")}]...`);
      await selectSources(page, sources);
    }

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
    // Perplexity shows a "N sources" button when the answer finishes.
    // The word varies by UI language — match any button whose text contains digits.
    await page.locator("button").filter({ hasText: /\d/ }).first().waitFor({ timeout: timeoutMs });

    await dismissDialogs(page);

    log("Extracting answer from DOM...");
    const [answer, citedSources] = await Promise.all([
      extractAnswer(page),
      extractSources(page),
    ]);

    log(`Done. Answer length: ${answer.length} chars, sources: ${citedSources.length}`);
    return { answer, sources: citedSources };
  } finally {
    await page.close();
  }
}

// Selects the given sources in the Perplexity "Connecteurs et sources" submenu.
// All icon IDs are locale-independent — they don't change with UI language.
async function selectSources(page: Page, sources: string[]): Promise<void> {
  const targetIcons = sources.map(s => SOURCE_ICON[s]).filter(Boolean);
  if (targetIcons.length === 0) return;

  // Open the "+" menu — located by its icon #pplx-icon-plus
  const addBtnLabel = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find(b => {
      const use = b.querySelector('use');
      return use && (use.getAttribute('xlink:href') === '#pplx-icon-plus' || use.getAttribute('href') === '#pplx-icon-plus');
    });
    return btn?.getAttribute('aria-label') ?? null;
  });
  if (!addBtnLabel) throw new Error("Could not find the + (add) button on Perplexity");
  await page.locator(`button[aria-label="${addBtnLabel}"]`).click();
  await page.waitForTimeout(300);

  // Open "Connecteurs et sources" submenu — located by its icon #pplx-icon-plug
  const connLabel = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => {
      const use = el.querySelector('use');
      return use && (use.getAttribute('xlink:href') === '#pplx-icon-plug' || use.getAttribute('href') === '#pplx-icon-plug');
    });
    return item?.getAttribute('aria-label') ?? item?.textContent?.trim() ?? null;
  });
  if (!connLabel) throw new Error("Could not find 'Connecteurs et sources' menuitem");
  await page.locator('[role="menuitem"]').filter({ hasText: connLabel.slice(0, 10) }).click();
  await page.locator('[role="menuitemcheckbox"]').first().waitFor({ state: "visible", timeout: 3_000 });

  // Read current state of all checkboxes
  const getCheckboxInfo = (iconId: string) => page.evaluate((id) => {
    const item = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find(el => {
      const use = el.querySelector('use');
      return use && (use.getAttribute('xlink:href') === id || use.getAttribute('href') === id);
    });
    return item ? { label: item.getAttribute('aria-label') ?? item.textContent?.trim() ?? "", checked: item.getAttribute('aria-checked') === 'true' } : null;
  }, iconId);

  // Build the desired state: check targets, uncheck everything else
  const allIcons = Object.values(SOURCE_ICON);
  for (const icon of allIcons) {
    const info = await getCheckboxInfo(icon);
    if (!info || !info.label) continue;
    const shouldBeChecked = targetIcons.includes(icon);
    if (info.checked !== shouldBeChecked) {
      await page.locator('[role="menuitemcheckbox"]').filter({ hasText: info.label }).click();
      await page.waitForTimeout(200);
    }
  }

  // Close menus
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
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
