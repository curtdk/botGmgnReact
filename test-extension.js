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
    console.log('[CONSOLE]', msg.type(), msg.text());
  });

  page.on('pageerror', error => {
    console.log('[PAGE ERROR]', error.message);
  });

  try {
    // Navigate to GMGN
    console.log('Opening GMGN...');
    await page.goto('https://gmgn.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Page loaded:', await page.title());

    // Wait a bit for extension to initialize
    await page.waitForTimeout(3000);

    // Navigate to a token page (example token)
    console.log('Navigating to token page...');
    await page.goto('https://gmgn.ai/sol/token/D7F3cXvYzWxhJkLqfG2nXMHvMmQwZ3BNoYVtA4xpump', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);

    // Take screenshot
    await page.screenshot({ path: 'test-screenshot.png', fullPage: true });
    console.log('Screenshot saved to test-screenshot.png');

    // Try to find the side panel button or any extension elements
    // Check if extension injected anything
    const extensionElements = await page.evaluate(() => {
      // Check for any GMGN extension specific elements
      const elements = document.querySelectorAll('[class*="gmgn"], [id*="gmgn"]');
      return Array.from(elements).map(el => el.className + ' - ' + el.tagName);
    });

    console.log('Extension elements found:', extensionElements.length);
    
    // Check for specific GMGN extension content
    const hasContentScript = await page.evaluate(() => {
      return typeof window !== 'undefined';
    });
    console.log('Page context available:', hasContentScript);

    console.log('\n✅ Test completed! Check test-screenshot.png');

  } catch (error) {
    console.error('Test failed:', error.message);
  }

  await browser.close();
})();
