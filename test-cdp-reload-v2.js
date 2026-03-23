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
  console.log('=== CDP Auto Reload Extension v2 ===\n');
  
  try {
    // Get all targets
    console.log('Getting targets...');
    const targets = await getTargets();
    
    // Find GMGN service worker
    // The extension ID is: dmlldkkgjgpaipnfgijhahncbohnfmkj
    let gmgnTarget = targets.find(t => 
      t.url && t.url.includes('dmlldkkgjgpaipnfgijhahncbohnfmkj')
    );
    
    console.log('GMGN targets found:');
    targets.filter(t => t.url && t.url.includes('dmlldkkgjgpaipnfgijhahncbohnfmkj')).forEach(t => {
      console.log('  -', t.type, ':', t.url?.substring(0, 80));
    });
    
    // Try to find the background page
    if (!gmgnTarget) {
      // Try to find service worker
      gmgnTarget = targets.find(t => 
        t.type === 'service_worker' && t.url && t.url.includes('dmlldkkgjgpaipnfgijhahncbohnfmkj')
      );
    }
    
    if (!gmgnTarget) {
      // Look for the background page with specific path
      gmgnTarget = targets.find(t => 
        t.url && t.url.includes('dmlldkkgjgpaipnfgijhahncbohnfmkj') && 
        (t.url.includes('background') || t.url.includes('service-worker'))
      );
    }
    
    if (!gmgnTarget) {
      console.log('\nTrying to find via extension ID directly...');
      gmgnTarget = targets.find(t => 
        t.type === 'page' && t.url && t.url.includes('dmlldkkgjgpaipnfgijhahncbohnfmkj')
      );
    }
    
    if (gmgnTarget) {
      console.log('\n✓ Found target:', gmgnTarget.type, gmgnTarget.url?.substring(0, 60));
      console.log('WebSocket:', gmgnTarget.webSocketDebuggerUrl?.substring(0, 60));
      
      // Connect via CDP
      console.log('\nConnecting via CDP...');
      const client = await CDP({ target: gmgnTarget.webSocketDebuggerUrl });
      
      const { Runtime } = client;
      
      // Try to reload
      console.log('Sending chrome.runtime.reload()...');
      try {
        const result = await Runtime.evaluate({
          expression: 'chrome.runtime.reload()',
          returnByValue: true
        });
        console.log('✓ Result:', result);
      } catch (e) {
        console.log('Error (expected):', e.message);
        console.log('This is normal - service worker may have restarted');
      }
      
      await client.close();
      console.log('\n✅ Reload command sent!');
    } else {
      console.log('\n❌ GMGN extension target not found');
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
  
  console.log('\n=== DONE ===');
}

reloadExtension();
