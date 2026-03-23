const { chromium } = require('playwright');

(async () => {
  console.log('=== Order Verification Test ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  let pages = contexts[0]?.pages() || [];
  
  // Open GMGN page
  let gmgnPage = pages.find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  
  console.log('1. Loading GMGN page...');
  await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
  await gmgnPage.waitForTimeout(5000);
  
  // Wait for sidepanel
  console.log('2. Waiting for SidePanel...');
  await gmgnPage.waitForTimeout(8000);
  
  const allPages = contexts[0].pages();
  const sidePanel = allPages.find(p => p.url().includes('sidepanel'));
  
  if (!sidePanel) {
    console.log('❌ SidePanel not found');
    await browser.close();
    return;
  }
  
  console.log('3. Clicking Start...');
  const startBtn = await sidePanel.$('button:has-text("开始")');
  if (startBtn) {
    await startBtn.click();
  }
  
  // Wait for initial data
  console.log('4. Waiting for initial data (15s)...');
  await sidePanel.waitForTimeout(15000);
  
  // Check data
  console.log('5. Checking data and order...\n');
  const info = await sidePanel.evaluate(() => {
    const bodyText = document.body.innerText;
    return {
      text: bodyText,
      hasError: bodyText.includes('错误') || bodyText.includes('不匹配') || bodyText.includes('顺序'),
      hasOrder: bodyText.includes('顺序') || bodyText.includes('Order'),
    };
  });
  
  console.log('=== RESULTS ===');
  console.log('Has Error/Order issue:', info.hasError);
  console.log('Has Order keyword:', info.hasOrder);
  
  // Show relevant text
  const lines = info.text.split('\n').filter(l => 
    l.includes('顺序') || l.includes('不匹配') || l.includes('错误') || l.includes('Order') || l.includes('验证') || l.includes('30')
  );
  
  if (lines.length > 0) {
    console.log('\n=== Order/Error Related Logs ===');
    lines.forEach(l => console.log(l));
  }
  
  // Get trade count
  const tradeMatch = info.text.match(/交易.*?(\d+)/);
  console.log('\nTrade count:', tradeMatch ? tradeMatch[1] : 'N/A');
  
  // Timing info
  console.log('\n=== TIMING ANALYSIS ===');
  console.log('1. Page load: ~5s');
  console.log('2. SidePanel wait: ~8s');
  console.log('3. Initial data: ~15s');
  console.log('Total: ~28s before first data');
  
  await sidePanel.screenshot({ path: 'order-test.png', fullPage: true });
  console.log('\nScreenshot: order-test.png');
  
  console.log('\n=== DONE ===');
  await browser.close();
})();
