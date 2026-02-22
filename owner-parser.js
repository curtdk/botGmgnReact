;(function(){
  function clean(v){return (v||'').replace(/[`]/g,'').trim()}
  function extractOwnerRecordsFromDoc(doc){
    var container=doc.querySelector('.g-table-body')||doc;
    var rows=[].slice.call(container.querySelectorAll('div[data-index]'));
    var addrReGlobal=new RegExp('[1-9A-HJ-NP-Za-km-z]{32,}','g');
    var out=[];
    for(var i=0;i<rows.length;i++){
      var row=rows[i];
      var primaryA=row.querySelector('a[href^="/sol/address/"]');
      var primaryAddr='';
      if(primaryA){ var href=clean(primaryA.getAttribute('href')||''); primaryAddr=href.split('/').pop().split(/[?#]/)[0] }
      var linkNodes=[].slice.call(row.querySelectorAll('a[href^="/sol/address/"]'));
      var linkAddrs=[]; for(var j=0;j<linkNodes.length;j++){ var h=clean(linkNodes[j].getAttribute('href')||''); var full=h.split('/').pop().split(/[?#]/)[0]; if(full) linkAddrs.push(full) }
      var textAddrs=[]; var mAll=(row.textContent||'').match(addrReGlobal); if(mAll){ for(var k=0;k<mAll.length;k++){ textAddrs.push(mAll[k]) } }
      var seen=new Set(); var addrs=[]; var comb=linkAddrs.concat(textAddrs); for(var a=0;a<comb.length;a++){ var it=comb[a]; if(!seen.has(it)){ seen.add(it); addrs.push(it) } }
      if(!addrs.length) continue;
      var main=primaryAddr || (linkAddrs.length ? linkAddrs[0] : addrs[0]);
      var funding='';
      if(linkAddrs.length>1){ for(var x=0;x<linkAddrs.length;x++){ if(linkAddrs[x]!==main){ funding=linkAddrs[x]; break } } }
      if(!funding){ for(var y=0;y<addrs.length;y++){ if(addrs[y]!==main){ funding=addrs[y]; break } } }
      for(var z=0;z<addrs.length;z++){ if(addrs[z].slice(0,4)==='Biw4' && addrs[z]!==main){ funding=addrs[z]; break } }
      var ageMatch=(row.textContent||'').match(/\b(\d+)d\b/); var walletAge=ageMatch?ageMatch[0]:'';
      var solVals=[]; var spans=[].slice.call(row.querySelectorAll('img[src*="icon_solanabal"] + span')); for(var s=0;s<spans.length;s++){ var t=(spans[s].textContent||'').trim(); if(t) solVals.push(t) }
      var usdVals=(row.textContent||'').match(/\$[0-9\.]+[A-Za-z0-9]*/g)||[];
      var txNode=row.querySelector('a[href*="solscan.io/tx/"]'); var txLink=txNode?txNode.getAttribute('href'):null;
      var sourceText=''; var candidates=['[title*="来源"]','[title*="资金来源"]','[class*="source"]','[class*="资金"]','[class*="来源"]'];
      for(var c=0;c<candidates.length;c++){ var el=row.querySelector(candidates[c]); if(el){ sourceText=(el.textContent||'').trim(); if(sourceText) break } }
      if(!sourceText && (/(^|\s)--(\s|$)/.test((row.textContent||'')))) sourceText='';
      out.push({ main_account:main, funding_account:funding, wallet_age:walletAge, solscan_account:null, solscan_tx:txLink, sol_balances:solVals, usd_values:usdVals, source_text:sourceText });
    }
    return out
  }
  function getOwnerRecordsFromHtml(html){ var doc=new DOMParser().parseFromString(html,'text/html'); return extractOwnerRecordsFromDoc(doc) }
  function getSourceMapFromHtml(html){ var recs=getOwnerRecordsFromHtml(html); var m=new Map(); for(var i=0;i<recs.length;i++){ var r=recs[i]; if(r.main_account){ m.set(r.main_account, r.source_text||'') } } return m }
  function parseOwnersByColumns(doc){
    var container=doc.querySelector('.g-table-body')||doc;
    var rows=[].slice.call(container.querySelectorAll('div[data-index]'));
    var out=[];
    for(var i=0;i<rows.length;i++){
      var row=rows[i];
      
      var cols=[].slice.call(row.querySelectorAll(':scope > div'));
      if(!cols.length){ cols=[].slice.call(row.children) }
      var columns_texts=[]; var columns_html_snippets=[];
      for(var ci=0;ci<cols.length;ci++){ var tx=(cols[ci].textContent||'').trim(); columns_texts.push(tx); var hs=String(cols[ci].innerHTML||''); columns_html_snippets.push(hs.slice(0,120)) }
      var lineText=(row.textContent||'').trim();
      var mainShort=''; var fundingShort='';
      function extractMainShort(str){
        // 1. 尝试标准 "ABCD...WXYZ" 格式
        var m=str.match(/(?:^|\s)\d{0,3}\s*([1-9A-HJ-NP-Za-km-z]{4,})\.\.\.([1-9A-HJ-NP-Za-km-z]{4})/);
        if(m){ var pre=m[1].slice(0,4); var suf=m[2]; return pre+'...'+suf }
        
        // 2. 尝试仅有前缀的情况 (用户案例: "1ac💦..." -> "1ac" -> "ac")
        // 规则：捕获行首的字符，如果是数字开头后跟Base58字符，则去除开头的数字(Rank 1-1000)
        var m2 = str.match(/^(\d*[1-9A-HJ-NP-Za-km-z]+)/);
        if(m2){ 
            // 去除开头的数字，只保留后面的地址部分
            return m2[1].replace(/^\d+/, '');
        }
        
        return '';
      }
      function extractMainAddressFull(row) {
        // 从行 HTML 内容中提取主地址 (完整地址)
        // 规则：从左侧开始，在第一个 '$' 符号出现之前的内容中，查找包含 '/sol/address/' 或 'solscan.io/account/' 的 <a> 标签
        // 使用 TreeWalker 严格按 DOM 顺序遍历，遇到 '$' 文本节点立即停止
        try {
            var walker = document.createTreeWalker(row, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null, false);
            var node;
            while(node = walker.nextNode()){
                // 1. 检查文本节点是否包含 '$'
                if(node.nodeType === Node.TEXT_NODE){
                    if(node.textContent.includes('$')) return ''; // 遇到 $ 还没找到，说明 Main Address 不在 $ 之前，停止查找
                }
                // 2. 检查 Element 节点是否是目标 <a>
                else if(node.nodeType === Node.ELEMENT_NODE && node.tagName === 'A'){
                    var href = (node.getAttribute('href') || '').trim();
                    var match = href.match(/\/sol\/address\/([1-9A-HJ-NP-Za-km-z]{32,})/);
                    if(!match) match = href.match(/solscan\.io\/account\/([1-9A-HJ-NP-Za-km-z]{32,})/);
                    
                    if(match){
                        // 找到了地址，且之前没有遇到过 '$'
                        return match[1];
                    }
                }
            }
        } catch (e) { console.warn('extractMainAddressFull error', e); }
        return '';
      }
      
      function extractFundingShort(str){ var pct=str.match(/[+\-]?\d+(?:\.\d+)?%/g); var tail=str; if(pct&&pct.length){ var last=pct[pct.length-1]; var idx=str.lastIndexOf(last); tail=str.slice(idx+last.length) } var p=tail.match(/(Binance|OKX|Kucoin(?:\s+Wal\w*)?|FixedFloat|OKX:\s*Hot\s*W\w*|Bybit)/i); if(p) return p[1]; var s=tail.match(/([1-9A-HJ-NP-Za-km-z]{4,})\.\.\.([1-9A-HJ-NP-Za-km-z]{4})/); if(s){ var pre=s[1].slice(0,4); var suf=s[2]; return pre+'...'+suf } if(/(^|\s)--(\s|$)/.test(tail)) return ''; return '' }
      mainShort = extractMainShort(lineText);
      var mainAddressFull = extractMainAddressFull(row);
      fundingShort = extractFundingShort(lineText);
      
      var balanceMatch=lineText.match(/🐟\s*([0-9]+(?:\.[0-9]+)?)/);
      var balance = balanceMatch ? balanceMatch[1] : '';
      var lastActiveMatch=lineText.match(/\b(\d+)([hm])\b/);
      var last_active = lastActiveMatch ? (lastActiveMatch[1]+lastActiveMatch[2]) : '';
      var ageAll=lineText.match(/\b(\d+)d\b/g)||[];
      var wallet_age = ageAll.length?ageAll[0]:'';
      var funding_age = ageAll.length?ageAll[ageAll.length-1]:'';
      var pair=lineText.match(/\$[0-9\.]+\s*\/\s*\$[0-9\.]+[KMBkmb]?/);
      var total_buy_u=''; var avg_market_cap='';
      if(pair){ var seg=pair[0].split('/'); total_buy_u=seg[0].trim(); avg_market_cap=seg[1].trim() }
      var amtMatch=lineText.match(/([0-9\.]+[KMB])\s*\/\s*\d+\s*TXs/);
      var total_buy_amount = amtMatch ? amtMatch[1] : '';
      var profitDollarMatches=lineText.match(/[+\-]\$[0-9\.]+[KMB]?/g)||[];
      var total_profit_u = profitDollarMatches.length ? profitDollarMatches[profitDollarMatches.length-1] : '';
      var profitPctMatches=lineText.match(/[+\-]?[0-9]+(?:\.[0-9]+)?%/g)||[];
      var total_profit_pct = profitPctMatches.length ? profitPctMatches[profitPctMatches.length-1] : '';
      
      var holding_share_u=''; var holding_share_pct='';
      
      // 策略：从右向左查找最后一个 "$金额...百分比" 组合
      // 覆盖案例：
      // 1. ...$10.490.27%8oZD... (标准)
      // 2. ...$00%... (零持仓)
      // 3. ...$3.88K99.83%-- (高持仓)
      // 正则逻辑：$金额 + 可能的空格 + 百分比 + 后面不再有百分号(锚定末尾)
      var shareMatch = lineText.match(/(\$[0-9\.]+[KMB]?)\s*([0-9\.]+%)(?=[^%]*$)/);

      if (shareMatch) {
          holding_share_u = shareMatch[1];
          holding_share_pct = shareMatch[2];
      }
      
      var tailNums=lineText.match(/([0-9]+(?:\.[0-9]+)?)(?![^]*\d)/);
      var funding_sol='';
      try{ var parts=lineText.split(/\s+/); for(var pi=parts.length-1;pi>=0;pi--){ if(/^\d+(?:\.\d+)?$/.test(parts[pi])){ funding_sol=parts[pi]; break } } }catch(_){ }
      out.push({ row_index: i, columns_texts: columns_texts, columns_html_snippets: columns_html_snippets
        , main_address_short: mainShort
        , main_address: mainAddressFull
        , funding_address_short: fundingShort
        , balance: balance
        , last_active: last_active
        , wallet_age: wallet_age
        , total_buy_u: total_buy_u
        , avg_market_cap: avg_market_cap
        , total_buy_amount: total_buy_amount
        , total_profit_u: total_profit_u
        , total_profit_pct: total_profit_pct
        , holding_share_u: holding_share_u
        , holding_share_pct: holding_share_pct
        , funding_age: funding_age
        , funding_sol: funding_sol
      });
    }
    return out
  }
  window.GMGNOwnerParser={extractOwnerRecordsFromDoc:extractOwnerRecordsFromDoc,getOwnerRecordsFromHtml:getOwnerRecordsFromHtml,getSourceMapFromHtml:getSourceMapFromHtml,parseOwnersByColumns:parseOwnersByColumns}
})();
