const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome with extension...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  const contexts = browser.contexts();
  let page = contexts[0]?.pages()[0];
  
  if (!page) {
    page = await contexts[0].newPage();
  }

  // Capture console
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('GMGN') || text.includes('extension') || text.includes('Helius') || text.includes('score') || text.includes('holder') || text.includes('token')) {
      console.log('[CONSOLE]', msg.type(), text);
    }
  });

  try {
    // Go to token page
    console.log('\n1. Opening token page...');
    await page.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: 'token-1-loaded.png', fullPage: true });
    console.log('   Saved: token-1-loaded.png');

    // Wait for data to load
    console.log('2. Waiting for data...');
    await page.waitForTimeout(10000);
    await page.screenshot({ path: 'token-2-data.png', fullPage: true });
    console.log('   Saved: token-2-data.png');

    // Check for extension data
    console.log('\n3. Checking extension data...');
    const extData = await page.evaluate(() => {
      // Try to find any extension-related data
      const results = {
        url: window.location.href,
        title: document.title,
        // Check for any injected elements
        hasExtensionUI: !!document.querySelector('[class*="extension"], [class*="gmgn"], [id*="extension"], [id*="gmgn"]'),
        // Check localStorage for extension data
        hasLocalStorage: Object.keys(localStorage).filter(k => k.includes('gmgn') || k.includes('extension') || k.includes('helius')).length,
        // Check for iframes (sidepanel)
        iframeCount: document.querySelectorAll('iframe').length,
      };
      
      // Try to find holder data in DOM
      const holders = document.querySelectorAll('[class*="holder"], [class*="whale"], [class*="score"]');
      results.holderElements = holders.length;
      
      return results;
    });
    console.log('   Extension data:', JSON.stringify(extData, null, 2));

    // Wait more and take final screenshot
    console.log('\n4. Final check...');
    await page.waitForTimeout(15000);
    await page.screenshot({ path: 'token-3-final.png', fullPage: true });
    console.log('   Saved: token-3-final.png');

    // Get page content for analysis
    console.log('\n5. Page analysis...');
    const pageAnalysis = await page.evaluate(() => {
      return {
        // Check for common token data elements
        hasPrice: !!document.querySelector('[class*="price"], [class*="Price"]'),
        hasHolder: !!document.querySelector('[class*="holder"], [class*="Holder"]'),
        hasTrades: !!document.querySelector('[class*="trade"], [class*="Trade"]'),
        hasScore: !!document.querySelector('[class*="score"], [class*="Score"]'),
        bodyText: document.body.innerText.substring(0, 2000)
      };
    });
    console.log('   Has price:', pageAnalysis.hasPrice);
    console.log('   Has holder:', pageAnalysis.hasHolder);
    console.log('   Has trades:', pageAnalysis.hasTrades);
    console.log('   Has score:', pageAnalysis.hasScore);

    console.log('\n✅ Test completed!');

  } catch (error) {
    console.error('Error:', error.message);
  }

  console.log('\nDone');
})();
