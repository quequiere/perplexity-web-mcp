#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ensureAuthenticated, checkSession } from "./auth.js";
import { ensureBrowser, getFirstPage } from "./browser.js";
import { search, searchWithSources, SearchResult, DEFAULT_TIMEOUT_MS } from "./search.js";
import { askWithFiles } from "./attachment.js";

// Models observed in the Perplexity UI model selector (2026-09).
// "Max"-tagged models (GPT-5.6 Sol, Claude Opus 5) excluded — require Max subscription.
export const MODELS = [
  "best",
  "gpt-5.6-terra",
  "gemini-3.8-flash",
  "claude-sonnet-5",
  "kimi-k3",
  "glm-5.3",
  "grok-4.6",
  "grok-4.7",
  "nemotron-3-ultra",
] as const;

function formatResult(result: SearchResult): string {
  if (!result.answer) return "No answer found. Perplexity may have changed its structure.";
  const sourcesText = result.sources.length > 0
    ? "\n\nSources:\n" + result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
    : "";
  return result.answer + sourcesText;
}

// --- CLI args ---
const args = process.argv.slice(2);

const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const TIMEOUT_MS = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) * 1000 : DEFAULT_TIMEOUT_MS;

// --- MCP server ---
const mcp = new FastMCP({
  name: "perplexity-web",
  version: "1.1.1",
});

mcp.addTool({
  name: "search",
  description:
    "Search the web using Perplexity.ai and get an AI-synthesized answer with cited sources. Uses default Perplexity settings.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    model: z.enum(MODELS).optional().describe("Answer model to use. Defaults to Perplexity's current selection."),
    timeout_seconds: z.number().optional().describe("Wait budget in seconds for the full answer; floor 300, default 600."),
    project: z.string().optional().describe("Perplexity project UUID or full project URL. Queries land in that project instead of the main history. Use for automation workspaces, e.g. the FB cron project."),
  }),
  execute: async ({ query, model, timeout_seconds, project }) => {
    await ensureBrowser();
    // Pro answers stream for minutes; 90s default truncates. Floor 300s
    // (user decision 2026-10-02).
    const budget = Math.max(300_000, timeout_seconds ? timeout_seconds * 1000 : TIMEOUT_MS);
    const result = await search(query, budget, model, project);
    return formatResult(result);
  },
});

mcp.addTool({
  name: "search_advanced",
  description:
    "Search Perplexity.ai with specific source selection. Lets you combine multiple sources (e.g. web + academic). Use this when source control matters; prefer `search` for general queries.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    sources: z
      .array(z.enum(["web", "academic", "social"]))
      .min(1)
      .describe("Sources to search: 'web' (general web), 'academic' (scholarly articles), 'social' (Reddit & forums). Can combine multiple."),
    model: z.enum(MODELS).optional().describe("Answer model to use. Defaults to Perplexity's current selection."),
  }),
  execute: async ({ query, sources, model }) => {
    await ensureBrowser();
    const result = await searchWithSources(query, TIMEOUT_MS, sources, model);
    return formatResult(result);
  },
});

mcp.addTool({
  name: "login",
  description:
    "Check if you are authenticated on Perplexity.ai. If not, opens a browser window so you can log in.",
  parameters: z.object({}),
  execute: async () => {
    await ensureBrowser();
    const page = await getFirstPage();
    const authenticated = await checkSession(page);
    if (authenticated) {
      return "Already authenticated on Perplexity.ai.";
    }
    await ensureAuthenticated();
    return "Login successful. You are now authenticated on Perplexity.ai.";
  },
});


mcp.addTool({
  name: "ask_with_file",
  description:
    "Ask Perplexity.ai a question WITH FILE ATTACHMENT(S) — uploads local files (code, PDF, CSV, images, docs, audio/video; paths on the server running this MCP) into the chat and returns the AI answer with sources. Use this when the question is about file content rather than the web.",
  parameters: z.object({
    query: z.string().describe("The question/instruction about the attached file(s)"),
    files: z
      .array(z.string())
      .min(1)
      .max(10)
      .describe("Absolute paths of files to attach (on this server). Accepted: source code, txt/md, pdf, docx, xlsx, pptx, csv, json/yaml/xml, images, audio, video."),
    model: z.enum(MODELS).optional().describe("Answer model to use. Defaults to Perplexity's current selection."),
    timeout_seconds: z
      .number()
      .int()
      .positive()
      .max(600)
      .optional()
      .describe("Max seconds to wait for the answer (default 180)."),
  }),
  execute: async ({ query, files, model, timeout_seconds }) => {
    await ensureBrowser();
    const result = await askWithFiles({
      query,
      files,
      model,
      timeoutMs: timeout_seconds ? timeout_seconds * 1000 : undefined,
    });
    return formatResult(result) + "\n\nThread: " + result.url;
  },
});

// --- Startup ---
async function main() {
  console.error(`[perplexity-web-mcp] Starting (timeout=${TIMEOUT_MS}ms)...`);
  console.error("[perplexity-web-mcp] Ready. Browser will launch on first tool call.");
  mcp.start({ transportType: "stdio" });
}

main().catch((err) => {
  console.error("[perplexity-web-mcp] Fatal error:", err);
  process.exit(1);
});
