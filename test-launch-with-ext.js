const { chromium } = require('playwright');

(async () => {
  console.log('=== Launch Chrome with Extension ===\n');
  
  // Launch Chrome with extension already loaded
  const extensionPath = '/Users/curtdk/.openclaw/workspace/botGmgnReact/dist';
  
  const browser = await chromium.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      '--no-sandbox',
      '--remote-debugging-port=9223'
    ]
  });

  console.log('Chrome launched with extension!');

  const context = await browser.newContext();
  const page = await context.newPage();

  // Go to GMGN
  console.log('1. Opening GMGN token page...');
  await page.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { 
    waitUntil: 'domcontentloaded',
    timeout: 60000 
  });
  await page.waitForTimeout(5000);
  console.log('   Page loaded');

  // Wait for sidepanel
  console.log('2. Waiting for SidePanel...');
  await page.waitForTimeout(8000);
  
  // Get all pages
  const allPages = context.pages();
  console.log('   Total pages:', allPages.length);
  
  const sidePanel = allPages.find(p => p.url().includes('sidepanel'));
  
  if (sidePanel) {
    console.log('3. SidePanel found!');
    
    // Click start
    const startBtn = await sidePanel.$('button:has-text("开始")');
    if (startBtn) {
      await startBtn.click();
      console.log('4. Start clicked!');
    }
    
    // Wait for data
    console.log('5. Waiting for data...');
    await sidePanel.waitForTimeout(15000);
    
    // Check version
    const info = await sidePanel.evaluate(() => {
      return { text: document.body.innerText };
    });
    
    console.log('\n=== VERSION CHECK ===');
    console.log('Has v1.0.2:', info.text.includes('v1.0.2'));
    console.log('Has 测试版:', info.text.includes('测试版'));
    
    const vMatch = info.text.match(/v(\d+\.\d+\.\d+)/);
    console.log('Version:', vMatch ? vMatch[0] : 'NOT FOUND');
    
    await sidePanel.screenshot({ path: 'launch-test-result.png', fullPage: true });
    console.log('\nSaved: launch-test-result.png');
  } else {
    console.log('   SidePanel not found');
  }

  console.log('\n=== DONE ===');
  // Keep browser open
  console.log('Browser will stay open for 30s...');
  await new Promise(r => setTimeout(r, 30000));
  await browser.close();
})();
