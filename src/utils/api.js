import { parsePriceText } from './priceParser';

// 核心数据 API (移植自原版 content.js)

// -------------------------------------------------------------------------
// 辅助函数
// -------------------------------------------------------------------------
function hasChromeStorage(){ try{ return !!(window.chrome && chrome.storage && chrome.storage.local) }catch(e){ return false } }

export async function stoGet(keys){
    if(hasChromeStorage()){
      try{ return await chrome.storage.local.get(keys) }catch(e){}
    }
    const out={};
    for(const k of keys){
      const raw=localStorage.getItem(k);
      try{ out[k]=JSON.parse(raw) }catch(_){ out[k]=raw }
    }
    return out;
}

export async function stoSet(obj){
    if(hasChromeStorage()){
      try{ await chrome.storage.local.set(obj); return }catch(e){}
    }
    for(const k in obj){
      const v=obj[k];
      try{ localStorage.setItem(k, JSON.stringify(v)) }catch(_){ localStorage.setItem(k, String(v)) }
    }
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

// -------------------------------------------------------------------------
// 数据获取
// -------------------------------------------------------------------------
export async function getKeys(){
    try{
        // 1. 优先尝试从统一存储中读取
        let data = {};
        try{ data = await stoGet(['env_keys', 'be_keys']); } catch(e){ console.warn('[GMGN API] stoGet error:', e); }
        
        let keys = data && data.env_keys;
        if(!keys || (Array.isArray(keys) && !keys.length)){
             if(typeof data.be_keys === 'string'){
                  keys = data.be_keys.split(/[\n,;，；\s]+/).map(x=>x.trim()).filter(Boolean);
             } else {
                  keys = data.be_keys;
             }
         }
        if(Array.isArray(keys) && keys.length) return keys;
    }catch(e){ console.warn('[GMGN API] getKeys error:', e); }
      
    try{
        // 2. 尝试从全局变量读取
        if(Array.isArray(window.ENV_KEYS)&&window.ENV_KEYS.length) return window.ENV_KEYS.slice();
    }catch(e){}
    try{
        // 3. 最后尝试从 env-keys.json 文件读取
        const url=chrome.runtime.getURL('env-keys.json');
        const r=await fetch(url,{cache:'no-store'});
        if(r.ok){const j=await r.json();if(Array.isArray(j)&&j.length) return j}
    }catch(e){}
    return []
}

async function fetchPage(address,key,offset,limit,timeoutMs){
    const url=`https://public-api.birdeye.so/defi/v3/token/holder?address=${encodeURIComponent(address)}&offset=${offset}&limit=${limit}&ui_amount_mode=scaled`;
    const ms=timeoutMs||12000;
    const controller=new AbortController();
    const id=setTimeout(()=>controller.abort(),ms);
    console.log('[GMGN API] GET', url, 'key', (key||'').slice(0,6)+'...')
    const r=await fetch(url,{method:'GET',headers:{accept:'application/json','x-chain':'solana','X-API-KEY':(key||'').trim()},signal:controller.signal});
    clearTimeout(id);
    if(r.status===429) throw new Error('HTTP 429');
    if(r.status===401) throw new Error('HTTP 401 Unauthorized - Key 无效');
    if(!r.ok) throw new Error('HTTP '+r.status);
    return r.json();
}

function normalize(data){
    if(!data) return [];
    // 兼容多种数据结构：Birdeye(data.items), GMGN(data.data.list/items)
    const list = (data.data && (data.data.items || data.data.list || data.data.holders)) || data.items || [];
    
    return list.map(x => {
        // 提取基础字段
        const owner = x.owner || x.address || x.wallet_address;
        const amount = String(x.amount || x.balance || '0');
        const ui_amount = parseFloat(x.ui_amount || x.uiAmount || x.amount_cur || 0);
        
        // 提取价值字段 (尽可能兼容更多字段名)
        const usd_value = parseFloat(x.usd_value || x.value || x.amount_usd || 0);
        
        // 提取统计字段
        const total_buy_u = parseFloat(x.total_buy_u || x.buy_volume_cur || 0);
        const holding_share_pct = parseFloat(x.holding_share_pct || x.amount_percentage || 0);
        const netflow_amount = parseFloat(x.netflow_usd || 0); // 新增：净流入金额 (USD)
        
        
        
        // 提取时间/来源
        const created_at = x.created_at || x.open_timestamp || 0;
        const from_address = (x.native_transfer && x.native_transfer.from_address) || x.funder || '';
        // 完整保留 native_transfer 对象（结构与原数据一致）
        const native_transfer = x.native_transfer ? {
            name: x.native_transfer.name || "Unknown",           // 例如 "Binance"
            from_address: x.native_transfer.from_address || "",  // 资助地址
            amount: x.native_transfer.amount || "0",              // 转账金额（字符串）
            timestamp: x.native_transfer.timestamp || 0,          // 时间戳
            tx_hash: x.native_transfer.tx_hash || ""              // 交易哈希
        } : {};

        return {
            owner,
            amount,
            ui_amount,
            usd_value,
            total_buy_u,
            netflow_amount, // 新增：净流入金额 (USD)
            holding_share_pct,
            created_at,
            funding_account: from_address,
            native_transfer,
            // 保留原始对象以备不时之需
            // _raw: x, 
            status: '散户'
        };
    });
}

export async function fetchAll(address, keys, limit=100, maxCount=1000, onProgress){
    const outIndex=new Map();
    let offset=0;
    let keyIndex=0;
    let key=keys[keyIndex]||'';
    let backoff=1000;
    
    while(outIndex.size<maxCount){
      try{
        if(onProgress) onProgress(`正在获取第 ${offset/limit + 1} 页...`);
        const j=await fetchPage(address,key,offset,limit,12000);
        const items=normalize(j);
        if(!items || items.length === 0) break; // 无数据则退出

        for(const it of items){outIndex.set(it.owner,it)}
        
        if(items.length<limit) break;
        offset+=limit;
        backoff=1000;
        await sleep(500);
      }catch(e){
        const msg=(e&&e.message?e.message:String(e));
        if(/HTTP\s*429/i.test(msg) || /Too\s*Many\s*Requests/i.test(msg) || /HTTP\s*403/i.test(msg) || /HTTP\s*401/i.test(msg)){
          keyIndex=(keyIndex+1)%Math.max(1,keys.length);
          if(keys.length > 0 && keyIndex === 0){
             console.warn('[GMGN API] 所有 Key 均尝试失败');
             // 抛出错误以便上层捕获并显示日志
             throw new Error('所有 Key 均尝试失败');
          }
          key=keys[keyIndex]||key;
          await sleep(backoff);
          backoff=Math.min(backoff*2,8000);
          continue;
        }else{
          throw e;
        }
      }
    }
    return Array.from(outIndex.values())
}

// 导出 normalize 供 hook 使用
export { normalize };

export async function getHolderConfig(){
    try{
      const v=await chrome.storage.local.get(['holder_limit','holder_max']);
      const limitVal=parseInt(v.holder_limit)||100;
      const maxVal=parseInt(v.holder_max)||1000;
      return {limitVal,maxVal};
    }catch(_){ return {limitVal:100,maxVal:1000} }
}

// 获取当前页面 Mint
export function getMintFromPage(){
    try{
      const path=location.pathname||'';
      const mToken=(path.match(/\/(?:sol\/)?token\/([^\/]+)/)||[])[1];
      if(mToken&&mToken.length>30){ return mToken.split(/[?#]/)[0] }

      const spans=document.querySelectorAll('span.text-text-300');
      for(let i=0;i<spans.length;i++){
        const txt=(spans[i].textContent||'').trim();
        if(/pump$/.test(txt)){
          const tAttr=spans[i].getAttribute('title')||spans[i].getAttribute('data-mint')||spans[i].getAttribute('data-address')||'';
          if(tAttr&&tAttr.length>30){ return tAttr.trim().split(/[?#]/)[0] }
        }
      }
      
      const possible=document.querySelector('[data-mint], .mint-address, .token-address');
      if(possible){
        const v=possible.getAttribute('data-mint')||possible.textContent||possible.value||'';
        if(v&&v.length>30){ return v.trim().split(/[?#]/)[0] }
      }
    }catch(e){ console.warn('[GMGN API] getMintFromPage error:', e) }
    return ''
}

// 查找并返回包含价格信息的 DOM 元素（用于 MutationObserver 绑定）
export function findPriceDOM() {
    try {
        // [新增] 策略 0: sentry 组件容器
        const sentryContainer = document.querySelector('[data-sentry-component="BaseInfoPriceView"]');
        if (sentryContainer) return sentryContainer;

        // 策略 1: 用户指定的顶层大容器 (最稳健)
        const topContainer = document.querySelector('div.flex.flex-1.items-center.justify-between[class*="gap-40px"]');
        if (topContainer) return topContainer;

        const titleSpans = document.querySelectorAll('.info-item-title');
        for (const span of titleSpans) {
            if (span.textContent.trim() === '价格') {
                const container = span.closest('.text-left') || span.parentElement?.parentElement;
                if (container) return container;
            }
        }
        
        // 备用策略：查找旧结构容器
        const oldContainer = document.querySelector('div[class*="gap-"][class*="flex"] > div');
        if (oldContainer) return oldContainer.parentElement;

    } catch (e) {
        console.warn('[GMGN API] findPriceDOM error:', e);
    }
    return null;
}

// 从页面获取当前价格
export function getPriceFromPage() {
    try {
        // 辅助函数：尝试从文本中提取并解析价格
        const tryParse = (text) => {
             if (!text) return 0;
             // 匹配价格模式: $? 数字.数字 (下标) 数字
             // 例如: $0.0₄245, 1.23, 0.0001
             // Regex: \$?(\d+(?:\.\d*)?(?:[₀-₉]+\d*)?)
             const m = text.match(/\$?(\d+(?:\.\d*)?(?:[₀-₉]+\d*)?)/);
             if (m) {
                 const raw = m[1];
                 const val = parsePriceText(raw);
                 // console.log(`[GMGN API] Parsed price: "${text}" -> "${raw}" -> ${val}`);
                 return val;
             }
             return 0;
        };

        // [新增] 策略 0: 使用 sentry 组件属性精确定位 (BaseInfoPriceView)
        // 这是最稳健的方法，通常包含价格文本
        const baseInfo = document.querySelector('[data-sentry-component="BaseInfoPriceView"]');
        if (baseInfo) {
            // 尝试直接从整个容器文本中提取
            const p = tryParse(baseInfo.textContent);
            if (p !== null && p > 0) return p;
        }

        // [原有] 策略 0.5: InfoItem (如果 BaseInfoPriceView 结构变化)
        const infoItems = document.querySelectorAll('[data-sentry-component="InfoItem"]');
        for (const item of infoItems) {
            const titleEl = item.querySelector('.info-item-title');
            if (titleEl && titleEl.textContent.trim() === '价格') {
                const valEl = item.querySelector('.info-item-value');
                if (valEl) {
                    const price = tryParse(valEl.textContent);
                    if (price !== null && price > 0) return price;
                }
            }
        }

        // 策略 A: 通过查找包含“价格”文本的标题元素
        const titleSpans = document.querySelectorAll('.info-item-title');
        for (const span of titleSpans) {
            if (span.textContent.trim() === '价格') {
                const container = span.closest('.text-left') || span.parentElement?.parentElement;
                
                if (container) {
                    const valDiv = container.querySelector('.info-item-value');
                    if (valDiv) {
                        const price = tryParse(valDiv.textContent);
                        if (price !== null) return price;
                    }
                }
            }
        }
        
        // 策略 B: 兼容旧逻辑 (备用)
        const columns = document.querySelectorAll('div[class*="gap-"][class*="flex"] > div');
        for (let i = 0; i < columns.length; i++) {
            const col = columns[i];
            const titleEl = col.querySelector('div.text-left, div');
            if (titleEl && titleEl.textContent.trim() === '价格') {
                const valueEls = col.querySelectorAll('div');
                if (valueEls.length >= 2) {
                    const price = tryParse(valueEls[1].textContent);
                    if (price !== null) return price;
                }
            }
        }
    } catch (e) {
        console.warn('[GMGN API] getPriceFromPage error:', e);
    }
    return 0;
}
