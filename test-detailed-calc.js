const { chromium } = require('playwright');

(async () => {
  console.log('=== Getting Detailed Calculation ===\n');
  
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const contexts = browser.contexts();
  
  // Find GMGN page
  let gmgnPage = contexts[0]?.pages().find(p => p.url().includes('gmgn.ai/sol/token'));
  if (!gmgnPage) {
    gmgnPage = await contexts[0].newPage();
    await gmgnPage.goto('https://gmgn.ai/sol/token/Dp9hzRzhpjJNyVgbufyzQtf7pToeDc8XuVAex5pfpump', { timeout: 30000 });
  }
  
  await gmgnPage.waitForTimeout(3000);
  
  // Find sidepanel
  await gmgnPage.waitForTimeout(8000);
  const sidePanel = contexts[0]?.pages().find(p => p.url().includes('sidepanel'));
  
  if (!sidePanel) {
    console.log('SidePanel not found');
    await browser.close();
    return;
  }
  
  // Click start
  const startBtn = await sidePanel.$('button:has-text("开始")');
  if (startBtn) await startBtn.click();
  
  // Wait for more data
  console.log('Waiting for data (25s)...');
  await sidePanel.waitForTimeout(25000);
  
  // Get full text
  const text = await sidePanel.evaluate(() => document.body.innerText);
  
  console.log('\n=== FULL TEXT ===');
  console.log(text);
  
  // Extract metrics
  const benLunMatch = text.match(/本轮下注[：:\s]*([\d.]+)/);
  const yiLuMatch = text.match(/已落袋[：:\s]*([\d.-]+)/);
  const costMatch = text.match(/本轮成本[：:\s]*([\d.-]+)/);
  const floatMatch = text.match(/浮盈浮亏[：:\s]*([\d.-]+)/);
  
  console.log('\n=== METRICS ===');
  console.log('本轮下注:', benLunMatch ? benLunMatch[1] + ' SOL' : 'N/A');
  console.log('已落袋:', yiLuMatch ? yiLuMatch[1] + ' SOL' : 'N/A');
  console.log('本轮成本:', costMatch ? costMatch[1] + ' SOL' : 'N/A');
  console.log('浮盈浮亏:', floatMatch ? floatMatch[1] + ' SOL' : 'N/A');
  
  // Verify calculation
  if (benLunMatch && yiLuMatch && costMatch) {
    const benLun = parseFloat(benLunMatch[1]);
    const yiLu = parseFloat(yiLuMatch[1]);
    const cost = parseFloat(costMatch[1]);
    const calculated = benLun - yiLu;
    console.log('\n=== VERIFICATION ===');
    console.log(`本轮成本 = 本轮下注 - 已落袋`);
    console.log(`${cost.toFixed(4)} = ${benLun.toFixed(4)} - ${yiLu.toFixed(4)}`);
    console.log(`计算结果: ${calculated.toFixed(4)}`);
    console.log(`匹配: ${Math.abs(cost - calculated) < 0.0001 ? '✅ 正确' : '❌ 错误'}`);
  }
  
  await sidePanel.screenshot({ path: 'detailed-calc.png', fullPage: true });
  console.log('\nScreenshot: detailed-calc.png');
  
  await browser.close();
})();
