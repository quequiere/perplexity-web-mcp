import type { Page } from "playwright";
import { newSearchPage } from "./browser.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
export const DEFAULT_TIMEOUT_MS = 90_000;

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

    log("Waiting for search to start...");
    // The "N sources" button (source count, e.g. "10 sources") appears while the answer text is
    // STILL streaming, so it is only a "search started" signal — not completion. Completion is
    // detected by answer-text stability in waitForStableAnswer below.
    await page.locator("button").filter({ hasText: /sources/i }).filter({ hasText: /\d/ }).first().waitFor({ timeout: timeoutMs });

    await dismissDialogs(page);

    log("Waiting for answer text to stabilize...");
    const answer = await waitForStableAnswer(page, query, timeoutMs);

    log("Extracting sources...");
    const citedSources = await extractSources(page);

    log(`Done. Answer length: ${answer.length} chars, sources: ${citedSources.length}`);
    return { answer, sources: citedSources };
  } finally {
    await page.close();
  }
}

// Waits until the answer text is non-empty and unchanged across 3 consecutive reads (~4.5s),
// so the tool does not return while the answer is still streaming. Bounded by the overall timeout.
async function waitForStableAnswer(page: Page, query: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSig = "";
  let stable = 0;
  let lastAnswer = "";
  while (Date.now() < deadline) {
    const ans = await extractAnswer(page, query);
    if (ans.length >= 20) {
      const sig = `${ans.length}:${ans.slice(0, 80)}`;
      if (sig === lastSig) {
        stable += 1;
        if (stable >= 3) return ans;
      } else {
        stable = 0;
        lastSig = sig;
      }
      lastAnswer = ans;
    }
    await page.waitForTimeout(1500);
  }
  return lastAnswer;
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

async function extractAnswer(page: Page, query: string): Promise<string> {
  return page.evaluate((q) => {
    const selectAnswerPanel = (panels: Element[]): Element | null => {
      const queryText = (q || "").trim();
      // The answer panel echoes the user's query; prefer it over the "Sources"/"Shopping" panels.
      if (queryText) {
        const byQuery = panels.find((p) => (p.textContent || "").includes(queryText));
        if (byQuery) return byQuery;
      }
      return (
        panels.find((p) => /sources/i.test(p.textContent || "") && /\d/.test(p.textContent || "")) ??
        panels.sort((a, b) => (b.textContent || "").length - (a.textContent || "").length)[0] ??
        null
      );
    };

    const panel = selectAnswerPanel(Array.from(document.querySelectorAll('[role="tabpanel"]')));
    if (!panel) return "";

    const clone = panel.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("button, [class*='cursor-pointer'], [role='button']").forEach((el) => el.remove());

    const lines = (clone.innerText ?? "")
      .replace(/\u00a0/g, " ")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Strip the echoed query from the first line (the answer panel starts with it).
    const queryTrimmed = (q || "").trim();
    if (queryTrimmed && lines.length && lines[0].startsWith(queryTrimmed)) {
      lines[0] = lines[0].slice(queryTrimmed.length).trim();
      if (!lines[0]) lines.shift();
    }

    const followUps = lines.findIndex((l) => /^follow[- ]?ups?$/i.test(l));
    if (followUps !== -1) lines.length = followUps;

    return lines
      .filter((l) => !/^searching/i.test(l) && !/^\d+\s*sources$/i.test(l))
      .join("\n")
      .replace(/searching the web\.{0,3}/gi, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }, query);
}

async function extractSources(page: Page): Promise<Source[]> {
  const srcBtn = page.locator("button").filter({ hasText: /sources/i }).filter({ hasText: /\d/ }).first();
  await srcBtn.click().catch(() => {});
  await page.waitForTimeout(2000);

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
