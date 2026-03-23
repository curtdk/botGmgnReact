const { chromium } = require('playwright');

(async () => {
  console.log('=== Fresh Test with Running Monitor ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  // Get GMGN page
  let gmgnPage = contexts[0]?.pages().find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
    await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
  }
  
  await gmgnPage.waitForTimeout(3000);
  
  // Find sidepanel
  await gmgnPage.waitForTimeout(10000);
  const sidePanel = contexts[0]?.pages().find(p => p.url().includes('sidepanel'));
  
  if (!sidePanel) {
    console.log('SidePanel not found, opening directly...');
    // Open sidepanel directly
    sidePanel = await contexts[0].newPage();
    await sidePanel.goto('chrome-extension://dmlldkkgjgpaipnfgijhahncbohnfmkj/src/sidepanel/index.html');
    await sidePanel.waitForTimeout(3000);
  }
  
  console.log('SidePanel found, clicking Start...');
  
  // Click 开始 (Start) button - try multiple times
  for (let i = 0; i < 3; i++) {
    const startBtn = await sidePanel.$('button:has-text("开始")');
    if (startBtn) {
      await startBtn.click();
      console.log('Clicked Start button');
      break;
    }
    await sidePanel.waitForTimeout(1000);
  }
  
  // Wait for data to flow
  console.log('Waiting for data flow (30s)...');
  await sidePanel.waitForTimeout(30000);
  
  // Get the text content
  const text = await sidePanel.evaluate(() => document.body.innerText);
  
  console.log('\n=== SidePanel Text (first 2000 chars) ===');
  console.log(text.substring(0, 2000));
  
  // Check status
  const isRunning = text.includes('运行中') || text.includes('实时');
  console.log('\n=== Status ===');
  console.log('Is Running:', isRunning);
  
  // Look for any numbers that could be metrics
  const numbers = text.match(/[\d.]+/g) || [];
  console.log('\n=== Numbers Found ===');
  console.log(numbers.slice(0, 50).join(', '));
  
  await sidePanel.screenshot({ path: 'fresh-test.png', fullPage: true });
  console.log('\nScreenshot: fresh-test.png');
  
  await browser.close();
})();
