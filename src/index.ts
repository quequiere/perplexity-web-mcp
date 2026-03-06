#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ensureAuthenticated, checkSession } from "./auth.js";
import { ensureBrowser, getFirstPage } from "./browser.js";
import { search, DEFAULT_TIMEOUT_MS } from "./search.js";

// --- CLI args ---
const args = process.argv.slice(2);

const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const TIMEOUT_MS = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) * 1000 : DEFAULT_TIMEOUT_MS;

// --- MCP server ---
const mcp = new FastMCP({
  name: "perplexity-web",
  version: "1.0.0",
});

mcp.addTool({
  name: "search",
  description:
    "Search the web using Perplexity.ai and get an AI-synthesized answer with cited sources.",
  parameters: z.object({
    query: z.string().describe("The search query"),
    mode: z
      .enum(["web", "academic", "news", "youtube", "reddit"])
      .optional()
      .default("web")
      .describe("Search focus mode"),
  }),
  execute: async ({ query }) => {
    await ensureBrowser();
    const result = await search(query, TIMEOUT_MS);

    if (!result.answer) {
      return "No answer found. Perplexity may have changed its structure.";
    }

    const sourcesText =
      result.sources.length > 0
        ? "\n\nSources:\n" +
          result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
        : "";

    return result.answer + sourcesText;
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
