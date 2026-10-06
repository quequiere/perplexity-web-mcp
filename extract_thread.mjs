import { ensureBrowser, getFirstPage } from '/home/paleta/pplx-mcp/dist/browser.js';
import { extractAnswer } from '/home/paleta/pplx-mcp/dist/search.js';

await ensureBrowser();
const page = await getFirstPage();
const url = process.argv[2];
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(12000);
let ans = '';
for (let i = 0; i < 15; i++) {
    ans = await extractAnswer(page);
    if (ans && ans.length > 2000) break;
    await page.waitForTimeout(6000);
}
console.log('ANSWER_LEN:', ans ? ans.length : 0);
if (ans) console.log('===ANSWER_START===');
if (ans) console.log(ans);
if (ans) console.log('===ANSWER_END===');
// NOTE: do NOT close the context — it would break the MCP server's browser
process.exit(0);
