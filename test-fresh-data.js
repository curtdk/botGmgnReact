const { chromium } = require('playwright');

(async () => {
  console.log('=== Testing with Popular Token ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  // Use a popular token with more data
  const tokenAddress = 'A1b6dZ4N4K3kN5J7kN8L9M0N1P2Q3R4S5T6U7V8W9X0Y1Z2'; // Random test
  
  // Let's just use the same Shibifart token but with fresh data
  console.log('Using Shibifart token with fresh data...');
  
  let gmgnPage = contexts[0]?.pages().find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
  }
  
  // Reload the page to get fresh data
  await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
  await gmgnPage.waitForTimeout(3000);
  
  // Find sidepanel
  await gmgnPage.waitForTimeout(10000);
  let sidePanel = contexts[0]?.pages().find(p => p.url().includes('sidepanel'));
  
  if (!sidePanel) {
    sidePanel = await contexts[0].newPage();
    await sidePanel.goto('chrome-extension://dmlldkkgjgpaipnfgijhahncbohnfmkj/src/sidepanel/index.html');
    await sidePanel.waitForTimeout(3000);
  }
  
  // Click start
  const startBtn = await sidePanel.$('button:has-text("开始")');
  if (startBtn) {
    await startBtn.click();
    console.log('Start clicked!\n');
  }
  
  // Wait for fresh data
  console.log('Waiting for fresh data (35s)...');
  await sidePanel.waitForTimeout(35000);
  
  // Get the text
  const text = await sidePanel.evaluate(() => document.body.innerText);
  
  // Extract metrics
  const benLunMatch = text.match(/本轮下注[：:\s]*([\d.]+)/);
  const yiLuMatch = text.match(/已落袋[：:\s]*([\d.-]+)/);
  const benLunCostMatch = text.match(/本轮成本[：:\s]*([\d.-]+)/);
  const fuYingMatch = text.match(/浮盈浮亏[：:\s]*([\d.-]+)/);
  
  console.log('\n========== FRESH DATA TEST ==========\n');
  console.log('【本轮下注】', benLunMatch ? benLunMatch[1] + ' SOL' : 'N/A');
  console.log('【已落袋】', yiLuMatch ? yiLuMatch[1] + ' SOL' : 'N/A');
  console.log('【本轮成本】', benLunCostMatch ? benLunCostMatch[1] + ' SOL' : 'N/A');
  console.log('【浮盈浮亏】', fuYingMatch ? fuYingMatch[1] + ' SOL' : 'N/A');
  
  // Verify formula
  if (benLunMatch && yiLuMatch && benLunCostMatch) {
    const benLun = parseFloat(benLunMatch[1]);
    const yiLu = parseFloat(yiLuMatch[1]);
    const cost = parseFloat(benLunCostMatch[1]);
    const calculated = benLun - yiLu;
    
    console.log('\n【公式验证】');
    console.log(`本轮成本 = 本轮下注 - 已落袋`);
    console.log(`${cost.toFixed(4)} = ${benLun.toFixed(4)} - ${yiLu.toFixed(4)}`);
    console.log(`计算值: ${calculated.toFixed(4)}`);
    console.log(`实际值: ${cost.toFixed(4)}`);
    console.log(`结果: ${Math.abs(calculated - cost) < 0.001 ? '✅ 正确' : '❌ 错误'}`);
  }
  
  // Extract user details
  console.log('\n【持仓用户明细】');
  const userLines = text.match(/持仓成本[=][\d.-]+/g) || [];
  console.log(`找到 ${userLines.length} 条持仓记录`);
  userLines.slice(0, 10).forEach(u => console.log('  ', u));
  
  await sidePanel.screenshot({ path: 'fresh-data-test.png', fullPage: true });
  console.log('\nScreenshot: fresh-data-test.png');
  
  await browser.close();
})();
