const { chromium } = require('playwright');

(async () => {
  const extensionPath = '/Users/curtdk/.openclaw/workspace/botGmgnReact/dist';
  
  const browser = await chromium.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox'
    ]
  });

  const context = await browser.newContext();
  const page = await context.newPage();

  // Capture console messages
  page.on('console', msg => {
    if (msg.type() === 'log' || msg.type() === 'error') {
      console.log('[CONSOLE]', msg.type(), msg.text());
    }
  });

  try {
    // Screenshot 1: Load GMGN homepage
    console.log('1. Loading GMGN homepage...');
    await page.goto('https://gmgn.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '01-homepage.png', fullPage: true });
    console.log('   Saved: 01-homepage.png');

    // Screenshot 2: Navigate to token page
    console.log('2. Loading token page...');
    await page.goto('https://gmgn.ai/sol/token/D7F3cXvYzWxhJkLqfG2nXMHvMmQwZ3BNoYVtA4xpump', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '02-token-page.png', fullPage: true });
    console.log('   Saved: 02-token-page.png');

    // Screenshot 3: Wait more for extension to run
    console.log('3. Waiting for extension to initialize...');
    await page.waitForTimeout(8000);
    await page.screenshot({ path: '03-extension-running.png', fullPage: true });
    console.log('   Saved: 03-extension-running.png');

    // Screenshot 4: Try opening side panel if possible
    console.log('4. Checking for extension elements...');
    const extensionInfo = await page.evaluate(() => {
      // Check for various potential extension markers
      return {
        hasIframe: !!document.querySelector('iframe[src*="sidepanel"]'),
        hasGmgnClass: !!document.querySelector('[class*="gmgn-extension"]'),
        url: window.location.href,
        title: document.title
      };
    });
    console.log('   Extension info:', extensionInfo);
    
    await page.screenshot({ path: '04-final-status.png', fullPage: true });
    console.log('   Saved: 04-final-status.png');

    console.log('\n✅ All screenshots saved!');

  } catch (error) {
    console.error('Test failed:', error.message);
  }

  await browser.close();
})();
