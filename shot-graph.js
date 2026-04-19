const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto('file:///C:/Users/massi/Revenant/design/imagined-tab-graph.html');
  await page.waitForLoadState('networkidle');
  await new Promise(r => setTimeout(r, 500));
  await page.screenshot({ path: path.join(process.cwd(), 'design', 'imagined-tab-graph.png'), fullPage: false });
  await browser.close();
  console.log('ok');
})();
