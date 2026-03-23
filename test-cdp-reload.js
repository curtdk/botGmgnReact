const CDP = require('chrome-remote-interface');
const http = require('http');

async function getTargets() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9222/json', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function reloadExtension() {
  console.log('=== CDP Auto Reload Extension ===\n');
  
  try {
    // Step 1: Get all targets
    console.log('Step 1: Getting CDP targets...');
    const targets = await getTargets();
    
    // Step 2: Find GMGN extension background page
    console.log('Step 2: Finding GMGN extension...');
    
    // The extension ID is: dmlldkkgjgpaipnfgijhahncbohnfmkj
    const gmgnTarget = targets.find(t => 
      t.url && t.url.includes('dmlldkkgjgpaipnfgijhahncbohnfmkj') && 
      (t.url.includes('background') || t.url.includes('_generated'))
    );
    
    if (!gmgnTarget) {
      console.log('Looking for other GMGN-related targets...');
      targets.forEach(t => {
        if (t.url && (t.url.includes('gmgn') || t.url.includes('extension'))) {
          console.log('  Found:', t.url.substring(0, 100));
        }
      });
      
      // Try any extension target
      const extTarget = targets.find(t => t.type === 'background_page' || t.type === 'service_worker');
      if (extTarget) {
        console.log('Trying background_page:', extTarget.url?.substring(0, 80));
      }
    }
    
    if (gmgnTarget) {
      console.log('Found GMGN target:', gmgnTarget.url?.substring(0, 80));
      
      // Step 3: Connect to the target
      console.log('\nStep 3: Connecting to target via CDP...');
      const client = await CDP({ target: gmgnTarget.webSocketDebuggerUrl });
      
      const { Runtime } = client;
      
      // Step 4: Execute chrome.runtime.reload()
      console.log('Step 4: Executing chrome.runtime.reload()...');
      await Runtime.evaluate({
        expression: 'chrome.runtime.reload()',
        returnByValue: true
      });
      
      console.log('✅ Extension reload command sent!');
      
      await client.close();
    } else {
      console.log('❌ GMGN extension background page not found');
      console.log('\nTrying alternative: Connect to any page and reload...');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
  
  console.log('\n=== DONE ===');
}

reloadExtension();
