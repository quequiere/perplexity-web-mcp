// Export Perplexity cookies in name/value alternating lines (inject-cookie parser format).
import { chromium } from "playwright";
import { writeFileSync } from "fs";

(async () => {
  const PROFILE = process.argv[2];
  const OUT = process.argv[3];
  if (!PROFILE || !OUT) { console.error("usage"); process.exit(2); }
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: false, args: ["--no-first-run", "--disable-gpu"] });
  const cookies = await ctx.cookies("https://www.perplexity.ai");
  await ctx.close();
  const wanted = cookies.filter(c => /__Secure/i.test(c.name));
  if (!wanted.length) { console.error("no pplx cookies found"); process.exit(1); }
  const lines = [];
  for (const c of wanted) { lines.push(c.name); lines.push(c.value); }
  writeFileSync(OUT, lines.join("\n"), { mode: 0o600 });
  console.log(`exported ${wanted.length} cookies: ${wanted.map(c=>c.name).join(", ")}`);
  process.exit(0);
})().catch(e => { console.error("ERR:", e.message); process.exit(1); });
