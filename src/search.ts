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

export async function search(query: string, timeoutMs: number, model?: string, project?: string): Promise<SearchResult> {
  log(`Search: "${query}" (timeout: ${timeoutMs}ms, model: ${model ?? "default"}, project: ${project ?? "main"})`);
  return runSearch(query, timeoutMs, null, model, project);
}

export async function searchWithSources(query: string, timeoutMs: number, sources: string[], model?: string, project?: string): Promise<SearchResult> {
  log(`Search: "${query}" sources=[${sources.join(",")}] (timeout: ${timeoutMs}ms, model: ${model ?? "default"}, project: ${project ?? "main"})`);
  return runSearch(query, timeoutMs, sources, model, project);
}

// Normalizes a project arg (UUID or full URL) into the project page URL.
export function projectUrl(project: string): string {
  if (/^https?:\/\//i.test(project)) return project;
  return `https://www.perplexity.ai/projects/${project.replace(/^\/+/, "")}`;
}

// Model names as they appear in the UI model selector (2026-09).
// Max-tier models omitted — account has Pro, not Max.
const MODEL_LABELS: Record<string, string> = {
  "best": "Best",
  "gpt-5.6-terra": "GPT-5.6 Terra",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  "claude-sonnet-5": "Claude Sonnet 5",
  "kimi-k3": "Kimi K3",
  "glm-5.3": "GLM 5.3",
  "grok-4.6": "Grok 4.6",
  "grok-4.7": "Grok 4.7",
  "nemotron-3-ultra": "Nemotron 3 Ultra",
};

// Opens the model selector and picks the given model.
// The trigger button shows the CURRENTLY SELECTED model name (not the word
// "Model") — locate it by its chevron-down icon + non-empty label.
// A synthetic DOM .click() is ignored by the UI; a real mouse click at the
// button's coordinates is required.
export async function selectModel(page: Page, model: string): Promise<void> {
  const label = MODEL_LABELS[model];
  if (!label) throw new Error(`Unknown model: ${model}`);

  const box = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll("button")).find(b => {
      const use = b.querySelector("use");
      const href = use?.getAttribute("xlink:href") || use?.getAttribute("href") || "";
      return href === "#pplx-icon-chevron-down" && !!(b.innerText || "").trim();
    });
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (!box) throw new Error("Model selector button not found");

  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(1000);

  // Menu items are role=menu entries whose text contains the model label
  const item = page.locator('[role="menu"] [role="menuitemradio"], [role="menu"] [role="menuitem"], [role="menu"] [role="option"], [role="menuitemradio"], [role="menuitem"], [role="option"]')
    .filter({ hasText: label }).first();
  await item.waitFor({ state: "visible", timeout: 5_000 });
  await item.click();
  await page.waitForTimeout(500);
  log(`Model selected: ${label}`);
}

async function runSearch(query: string, timeoutMs: number, sources: string[] | null, model?: string, project?: string): Promise<SearchResult> {
  const page = await newSearchPage();

  try {
    const startUrl = project ? projectUrl(project) : PERPLEXITY_HOME;
    log(`Navigating to ${project ? "project " : ""}perplexity.ai...`);
    await page.goto(startUrl, { waitUntil: "domcontentloaded" });
    await dismissDialogs(page);

    // Wait for the search input to be ready before any further interaction
    await page.locator("#ask-input").first().waitFor({ state: "visible", timeout: 10_000 });
    // Second dismiss pass (2026-10-03, pop-os e3ab75d): a late consent overlay can
    // appear after the input becomes visible and eats the model-selector click.
    await dismissDialogs(page);

    if (model) {
      log(`Selecting model: ${model}...`);
      try {
        await selectModel(page, model);
      } catch (e) {
        if (project) {
          // Project pages have a different settings picker (preset menu with
          // nested Radix submenu that resists automation, 2026-10-02). The
          // project's own default model applies — continue instead of failing.
          log(`Model selection failed on project page (${(e as Error).message.split('\n')[0]}) — using project default model.`);
        } else {
          throw e;
        }
      }
    }

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
    // Poll until the answer paragraph stabilizes (or the anonymous login wall /
    // the sources badge appears). The old "button with digits" heuristic fires
    // too early on sidebar/toolbar buttons.
    const outcome = await waitForCompletion(page, timeoutMs);
    if (outcome === "wall") {
      // Anonymous wall — Perplexity often answers the 2nd query from the
      // same session, so retry once before giving up.
      log("Anonymous login wall hit, retrying query...");
      const retryBox = page.locator("#ask-input").first();
      await retryBox.click();
      await retryBox.fill(query);
      await retryBox.press("Enter");
      await waitForCompletion(page, timeoutMs);
    }

    await dismissDialogs(page);

    log("Extracting answer from DOM...");
    const [answerRaw, citedSources] = await Promise.all([
      extractAnswer(page),
      extractSources(page),
    ]);
    // 2026 UI: the thread panel starts with the question bubble — strip it.
    let answer = answerRaw.trim();
    const qhead = query.trim().slice(0, 60);
    if (qhead && answer.startsWith(qhead)) {
      answer = answer.slice(qhead.length).trim();
    }

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

// Waits until the answer in the thread-content area stabilizes, the anonymous
// login wall appears, or the timeout elapses. Returns "ok" | "wall" | "timeout".
export async function waitForCompletion(page: Page, timeoutMs: number): Promise<"ok" | "wall" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  const POLL_MS = 1500;
  let lastLen = -1;
  let stableSince = 0;
  const STABLE_NEEDED = 2; // consecutive stable polls (~3 s of no change)

  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    const state = await page.evaluate(() => {
      const tc = document.querySelector('div[class*="thread-content"]') ?? document.querySelector('[role="tabpanel"]');
      const body = document.body.innerText;
      return {
        answerLen: (tc as HTMLElement | null)?.innerText.trim().length ?? 0,
        hasSources: /Sources\s*\n?\s*\d+/i.test(body),
        generating: /Searching the web|Researching|Starting/i.test(body),
        wall: /Sign up and repeat your request/i.test(body),
      };
    });

    if (state.wall) return "wall";
    // Done = sources badge present, no "Searching" indicator, AND the answer
    // text has stopped growing. The badge appears before the text finishes
    // streaming, so returning on the badge alone truncates the answer.
    if (state.answerLen === lastLen && state.answerLen > 0) {
      stableSince++;
      const settled = stableSince >= STABLE_NEEDED && state.answerLen > 50;
      if (settled && state.hasSources && !state.generating) return "ok";
      if (settled && !state.generating) return "ok";
    } else {
      stableSince = 0;
    }
    lastLen = state.answerLen;
  }
  return "timeout";
}

export async function dismissDialogs(page: Page): Promise<void> {
  // Generic dismiss first: Escape closes open menus, bottom sheets and toast
  // overlays that would otherwise intercept the model-selector click
  // ("subtree intercepts pointer events" TimeoutError, seen 2026-10-02).
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
  // Cookie policy bottom sheet (project pages, seen 2026-10-02) — buttons
  // "Allow all" / "Only necessary". Old FR/EN banner variants kept too.
  const cookieBtn = page.locator(
    'button:has-text("Cookies nécessaires"), button:has-text("Necessary cookies"), button:has-text("Allow all"), button:has-text("Only necessary"), button:has-text("Povolit vše"), button:has-text("Pouze nezbytné"), button:has-text("Přijmout vše")'
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

export async function extractAnswer(page: Page): Promise<string> {
  return page.evaluate(() => {
    // 2026 UI: answer lives in div[class*="thread-content"]; old UI used [role="tabpanel"]
    const panel =
      document.querySelector('div[class*="thread-content"]') ??
      document.querySelector('[role="tabpanel"]');
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
        parts.push("```\n" + text + "\n```");
      } else if (tag === "li") {
        parts.push("- " + text);
      } else {
        parts.push(text);
      }
    });

    let result = parts.join("\n").trim();
    if (!result) {
      // Fallback: no block elements found (Perplexity sometimes renders answer
      // as plain text nodes or unusual tags) — use visible innerText of the panel.
      result = (panel as HTMLElement).innerText.trim();
    }
    return result;
  });
}

export async function extractSources(page: Page): Promise<Source[]> {
  return page.evaluate(() => {
    const sources: { title: string; url: string }[] = [];
    const seen = new Set<string>();

    document.querySelectorAll<HTMLAnchorElement>('a[href^="http"]').forEach((link) => {
      const url = link.href;
      if (seen.has(url) || url.includes("perplexity.ai")) return;
      if (/perplexity\.com\/hub\/(legal|privacy)/i.test(url)) return;
      seen.add(url);
      const title = link.textContent?.trim() || new URL(url).hostname;
      sources.push({ title, url });
    });

    return sources.slice(0, 10);
  });
}
