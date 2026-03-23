const { chromium } = require('playwright');

(async () => {
  // Connect to existing Chrome with debugging port
  console.log('Connecting to existing Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  console.log('Connected!');

  // Get existing context
  const contexts = browser.contexts();
  let context, page;
  
  if (contexts.length > 0) {
    context = contexts[0];
    const pages = context.pages();
    if (pages.length > 0) {
      page = pages[0];
      console.log('Using existing page:', page.url());
    }
  }
  
  if (!page) {
    context = await browser.newContext();
    page = await context.newPage();
  }

  // Capture console messages
  page.on('console', msg => {
    if (msg.type() === 'log' || msg.type() === 'error') {
      console.log('[CONSOLE]', msg.type(), msg.text());
    }
  });

  try {
    // Screenshot 1: Current page
    console.log('1. Current page...');
    await page.screenshot({ path: '01-current.png', fullPage: true });
    console.log('   Saved: 01-current.png');

    // Screenshot 2: Navigate to GMGN
    console.log('2. Loading GMGN...');
    await page.goto('https://gmgn.ai', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: '02-gmgn-home.png', fullPage: true });
    console.log('   Saved: 02-gmgn-home.png');

    // Screenshot 3: Token page
    console.log('3. Loading token page...');
    await page.goto('https://gmgn.ai/sol/token/D7F3cXvYzWxhJkLqfG2nXMHvMmQwZ3BNoYVtA4xpump', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '03-token-page.png', fullPage: true });
    console.log('   Saved: 03-token-page.png');

    // Screenshot 4: After waiting
    console.log('4. After waiting...');
    await page.waitForTimeout(5000);
    await page.screenshot({ path: '04-after-wait.png', fullPage: true });
    console.log('   Saved: 04-after-wait.png');

    // Get extension info
    console.log('\nExtension info:');
    const extInfo = await page.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        cookies: document.cookie.length > 0 ? 'has cookies' : 'no cookies'
      };
    });
    console.log(extInfo);

    console.log('\n✅ Done!');

  } catch (error) {
    console.error('Error:', error.message);
  }

  // Don't close the browser - keep it running
  console.log('Keeping browser open...');
})();
