const { chromium } = require('playwright');

(async () => {
  // Connect to existing Chrome
  console.log('Connecting to existing Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  console.log('Connected!');

  const contexts = browser.contexts();
  let page = contexts[0]?.pages()[0] || await browser.newContext().then(c => c.newPage());

  try {
    // Step 1: Go to extensions page
    console.log('1. Opening chrome://extensions...');
    await page.goto('chrome://extensions', { timeout: 10000 });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'step1-extensions-page.png' });
    console.log('   Saved: step1-extensions-page.png');
    console.log('   URL:', page.url());

    // Step 2: Check for developer mode
    console.log('2. Checking extensions page...');
    const extInfo = await page.evaluate(() => {
      const cards = document.querySelectorAll('extension-card, div[id*="card"]');
      return {
        total: cards.length,
        hasDevMode: !!document.querySelector('[id*="developer"]'),
        url: window.location.href
      };
    });
    console.log('   Extension cards:', extInfo);

    await page.screenshot({ path: 'step2-extensions-check.png' });
    console.log('   Saved: step2-extensions-check.png');

    // Step 3: Try to find if our extension is loaded
    console.log('3. Looking for GMGN extension...');
    const gmgnExt = await page.evaluate(() => {
      const items = document.querySelectorAll('*');
      for (let item of items) {
        if (item.textContent && item.textContent.includes('GMGN')) {
          return item.textContent.substring(0, 100);
        }
      }
      return 'Not found in text';
    });
    console.log('   GMGN text found:', gmgnExt);

    // Step 4: Open a new tab with GMGN
    console.log('4. Opening GMGN in new tab...');
    const gmgnPage = await contexts[0].newPage();
    await gmgnPage.goto('https://gmgn.ai/sol/token/D7F3cXvYzWxhJkLqfG2nXMHvMmQwZ3BNoYVtA4xpump', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await gmgnPage.waitForTimeout(3000);
    await gmgnPage.screenshot({ path: 'step4-gmgn-loaded.png', fullPage: true });
    console.log('   Saved: step4-gmgn-loaded.png');

    // Step 5: Check page for extension elements
    console.log('5. Checking page for extension...');
    const pageCheck = await gmgnPage.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        hasIframes: document.querySelectorAll('iframe').length,
        bodyClasses: document.body.className
      };
    });
    console.log('   Page info:', pageCheck);

    await gmgnPage.screenshot({ path: 'step5-final-check.png', fullPage: true });
    console.log('   Saved: step5-final-check.png');

    console.log('\n✅ All steps completed!');

  } catch (error) {
    console.error('Error:', error.message);
    await page.screenshot({ path: 'error-screenshot.png' });
  }

  console.log('Done - keeping browser open');
})();
