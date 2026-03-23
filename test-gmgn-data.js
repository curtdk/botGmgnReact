const { chromium } = require('playwright');

(async () => {
  console.log('=== Getting Data from GMGN Page ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  let gmgnPage = contexts[0]?.pages().find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  
  // Get page data
  const pageData = await gmgnPage.evaluate(() => {
    // Try to get data from GMGN's own UI
    const results = {
      url: window.location.href,
      title: document.title,
    };
    
    // Look for holder data in the page
    const holders = document.querySelectorAll('[class*="holder"], [class*="Holder"]');
    results.holderElements = holders.length;
    
    // Look for trade data
    const trades = document.querySelectorAll('[class*="trade"], [class*="Trade"], [class*="token-trades"]');
    results.tradeElements = trades.length;
    
    // Try to find any numerical data
    const bodyText = document.body.innerText;
    
    // Extract any SOL values
    const solMatches = bodyText.match(/(\d+\.?\d*)\s*SOL/gi);
    results.solValues = solMatches ? [...new Set(solMatches)].slice(0, 20) : [];
    
    // Check localStorage for any GMGN data
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.includes('gmgn') || key.includes('holder') || key.includes('trade')) {
        ls[key] = localStorage.getItem(key).substring(0, 200);
      }
    }
    results.localStorage = ls;
    
    return results;
  });
  
  console.log('=== GMGN Page Data ===');
  console.log('URL:', pageData.url);
  console.log('Title:', pageData.title);
  console.log('Holder elements:', pageData.holderElements);
  console.log('Trade elements:', pageData.tradeElements);
  console.log('\nSOL values found:');
  pageData.solValues.forEach(v => console.log('  ', v));
  console.log('\nLocalStorage keys:', Object.keys(pageData.localStorage));
  
  // Check if there's any injected data from our extension
  const extData = await gmgnPage.evaluate(() => {
    // Look for any window.__GMGN_DATA or similar
    const results = {};
    
    if (window.gmgnData) results.gmgnData = 'exists';
    if (window.heliusData) results.heliusData = 'exists';
    if (window.holderData) results.holderData = 'exists';
    
    return results;
  });
  
  console.log('\nExtension data:', extData);
  
  await gmgnPage.screenshot({ path: 'gmgn-data.png', fullPage: true });
  console.log('\nScreenshot: gmgn-data.png');
  
  await browser.close();
})();
