import fs from "fs";
import path from "path";
import type { Page } from "playwright";
import { newSearchPage } from "./browser.js";
import { dismissDialogs, selectModel, waitForCompletion, extractAnswer, extractSources } from "./search.js";
import type { SearchResult } from "./search.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
const DEFAULT_FILE_TIMEOUT_MS = 180_000; // uploads + long answers need more time

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

// Extension allowlist mirroring the hidden <input type=file> accept attribute
// (probed on the live UI, 2026-09). Unknown extensions pass with a warning —
// Perplexity itself rejects what it doesn't support.
const KNOWN_EXT = new Set([
  ".bash", ".bat", ".c", ".coffee", ".conf", ".config", ".cpp", ".cs", ".css",
  ".csv", ".cxx", ".dart", ".diff", ".doc", ".docx", ".fish", ".go", ".h",
  ".hpp", ".htm", ".html", ".in", ".ini", ".ipynb", ".java", ".js", ".json",
  ".jsx", ".kts", ".kt", ".latex", ".less", ".log", ".lua", ".m", ".markdown",
  ".md", ".pdf", ".php", ".pl", ".pm", ".pptx", ".py", ".r", ".rb", ".rmd",
  ".rs", ".scala", ".sh", ".sql", ".swift", ".t", ".tex", ".text", ".toml",
  ".ts", ".tsx", ".txt", ".xlsx", ".xml", ".yaml", ".yml", ".zsh",
  ".jpeg", ".jpg", ".jpe", ".jp2", ".png", ".gif", ".bmp", ".tiff", ".tif",
  ".svg", ".webp", ".ico", ".avif", ".heic", ".heif",
  ".mp3", ".wav", ".aiff", ".ogg", ".flac",
  ".mp4", ".mpeg", ".mov", ".avi", ".flv", ".mpg", ".webm", ".wmv", ".3gp",
]);

export interface AskWithFilesOptions {
  query: string;
  files: string[];          // absolute paths on THIS machine (the server)
  timeoutMs?: number;
  model?: string;
}

// Attaches files to the composer and verifies each upload finished
// (an attachment chip with the file name appears).
async function attachFiles(page: Page, files: string[]): Promise<void> {
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 10_000 });

  const names = files.map(f => path.basename(f));
  await input.setInputFiles(files);

  // Wait until every file name shows up as a chip in the composer.
  // (Upload is async — submitting before chips settle sends a query with no file.)
  const deadline = Date.now() + 30_000;
  for (const name of names) {
    let visible = false;
    while (Date.now() < deadline && !visible) {
      visible = await page.evaluate((n) => {
        const composer =
          document.querySelector('form') ??
          document.querySelector('[class*="composer"]') ??
          document.body;
        return (composer as HTMLElement).innerText.includes(n);
      }, name);
      if (!visible) await page.waitForTimeout(1_000);
    }
    if (!visible) throw new Error(`Attachment "${name}" did not appear in the composer (rejected or too large?)`);
    log(`Attached: ${name}`);
  }
}

export async function askWithFiles(opts: AskWithFilesOptions): Promise<SearchResult & { url: string }> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_FILE_TIMEOUT_MS;
  log(`AskWithFiles: "${opts.query}" files=[${opts.files.map(f => path.basename(f)).join(",")}] (timeout: ${timeoutMs}ms, model: ${opts.model ?? "default"})`);

  // Fail fast on bad paths — before burning a browser session.
  for (const f of opts.files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    const stat = fs.statSync(abs);
    if (!stat.isFile()) throw new Error(`Not a regular file: ${abs}`);
    if (!KNOWN_EXT.has(path.extname(abs).toLowerCase()))
      log(`WARNING: extension "${path.extname(abs)}" not in known allowlist — Perplexity may reject it`);
  }

  const page = await newSearchPage();
  try {
    log("Navigating to perplexity.ai...");
    await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
    await dismissDialogs(page);
    await page.locator("#ask-input").first().waitFor({ state: "visible", timeout: 15_000 });

    if (opts.model) {
      log(`Selecting model: ${opts.model}...`);
      await selectModel(page, opts.model);
    }

    log("Attaching files...");
    await attachFiles(page, opts.files);

    log("Typing query...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const searchBox = page.locator("#ask-input").first();
    await searchBox.click();
    await searchBox.fill(opts.query);
    await searchBox.press("Enter");

    log("Waiting for answer to complete...");
    const outcome = await waitForCompletion(page, timeoutMs);
    if (outcome === "wall") throw new Error("Hit the anonymous login wall while authenticated — session likely expired, re-inject the cookie.");
    if (outcome === "timeout") log(`Answer did not stabilize within ${timeoutMs}ms — extracting what is there.`);

    await dismissDialogs(page);
    log("Extracting answer from DOM...");
    const [answer, sources] = await Promise.all([extractAnswer(page), extractSources(page)]);
    const url = page.url();
    log(`Done. Answer length: ${answer.length} chars, sources: ${sources.length}, url: ${url}`);
    return { answer, sources, url };
  } finally {
    await page.close();
  }
}
