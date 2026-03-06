#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ensureAuthenticated, checkSession } from "./auth.js";
import { ensureBrowser, getFirstPage } from "./browser.js";
import { search, searchWithSources, SearchResult, DEFAULT_TIMEOUT_MS } from "./search.js";

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
  }),
  execute: async ({ query }) => {
    await ensureBrowser();
    const result = await search(query, TIMEOUT_MS);
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
  }),
  execute: async ({ query, sources }) => {
    await ensureBrowser();
    const result = await searchWithSources(query, TIMEOUT_MS, sources);
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
