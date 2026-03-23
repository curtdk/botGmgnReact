const { chromium } = require('playwright');

(async () => {
  console.log('Connecting to Chrome...');
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  
  const contexts = browser.contexts();
  let page = contexts[0]?.pages()[0] || await contexts[0].newPage();

  // Capture console logs
  const logs = [];
  page.on('console', msg => {
    const text = msg.text();
    logs.push(`[${msg.type()}] ${text}`);
    if (text.includes('本轮下注') || text.includes('benLun') || text.includes('holdingCost') || text.includes('持仓成本')) {
      console.log('RELEVANT:', text);
    }
  });

  try {
    // Navigate to token page
    console.log('1. Loading token page...');
    await page.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    
    // Wait for "开始" button and click it
    console.log('2. Looking for Start button...');
    const startBtn = await page.$('button:has-text("开始"), button:has-text("运行")');
    if (startBtn) {
      await startBtn.click();
      console.log('   Clicked Start button');
      await page.waitForTimeout(2000);
    }

    // Wait for data to flow
    console.log('3. Waiting for data (30s)...');
    await page.waitForTimeout(30000);

    // Take screenshot
    await page.screenshot({ path: 'verify-metrics.png', fullPage: true });
    console.log('   Saved: verify-metrics.png');

    // Get all console logs
    console.log('\n--- All relevant logs ---');
    const relevantLogs = logs.filter(l => 
      l.includes('本轮') || 
      l.includes('下注') || 
      l.includes('持仓') || 
      l.includes('成本') ||
      l.includes('落袋') ||
      l.includes('SOL') ||
      l.includes('holder') ||
      l.includes('whale')
    );
    
    relevantLogs.forEach(l => console.log(l));

    console.log('\n--- Full log count:', logs.length, '---');

    console.log('\n✅ Test completed!');

  } catch (error) {
    console.error('Error:', error.message);
  }

  await browser.close();
})();
