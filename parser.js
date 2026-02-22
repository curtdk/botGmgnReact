;(function(){
  function clean(v){return (v||'').replace(/^\s*`+|`+\s*$/g,'').trim()}
  function safeHref(h){return (h||'').replace(/`/g,'').trim()}
  function isBuyByClass(row){return !!row.querySelector('.text-increase-200')}
  function isSellByClass(row){return !!row.querySelector('.text-decrease-200')}
  function normalizeAction(t,row){var s=(t||'').trim();if(!s){if(isBuyByClass(row))return 'Buy';if(isSellByClass(row))return 'Sell';return ''}if(/买/.test(s))return 'Buy';if(/卖/.test(s))return 'Sell';if(isBuyByClass(row))return 'Buy';if(isSellByClass(row))return 'Sell';return s}
  function textStartsWithDollarNotPrice(t){return /^\$/.test(t)&&t.indexOf('₅')===-1}
  function parseAddresses(doc){var as=[].slice.call(doc.querySelectorAll('a[href^="/sol/address/"]'));var list=as.map(function(a){var href=a.getAttribute('href')||'';var addr=clean(href.split('/').pop());return {address:addr,href:safeHref(href),label:clean(a.textContent||'')}});var seen=new Set();var unique=[];for(var i=0;i<list.length;i++){var it=list[i];if(!it.address)continue;if(seen.has(it.address))continue;seen.add(it.address);unique.push(it)}return unique}
  function parseTxs(doc){var as=[].slice.call(doc.querySelectorAll('a[href*="solscan.io/tx/"]'));return as.map(function(a){var href=a.getAttribute('href')||'';var tx=clean(href.split('/').pop());return {tx:tx,href:safeHref(href)}})}
  function parseRecords(doc){
    var rows=[].slice.call(doc.querySelectorAll('.relative.py-1px .flex.flex-row'));
    var out=[];
    for(var r=0;r<rows.length;r++){
      var row=rows[r];
      var actionNode=row.querySelector('.text-increase-200, .text-decrease-200');
      var action=normalizeAction(actionNode?actionNode.textContent:'',row);
      var priceNode=row.querySelector('div[title^="$"]');
      var priceText=priceNode?((priceNode.textContent||'').trim()):'';
      var amountNode=row.querySelector('div.text-text-200');
      var amountText=amountNode?(amountNode.textContent||'').trim():'';
      var valueText='';
      var divs=[].slice.call(row.querySelectorAll('div'));
      for(var di=0;di<divs.length;di++){var t=(divs[di].textContent||'').trim();if(textStartsWithDollarNotPrice(t)){valueText=t;break}}
      var addrA=row.querySelector('a[href^="/sol/address/"]');
      var addrHref=addrA?addrA.getAttribute('href'):'';
      var addr=clean((addrHref||'').split('/').pop());
      var txA=row.querySelector('a[href*="solscan.io/tx/"]');
      var txHref=txA?txA.getAttribute('href'):'';
      var tx=clean((txHref||'').split('/').pop());
      var timeLabel='';
      var timeCandidates=[].slice.call(row.querySelectorAll('.text-text-300.font-medium .flex, .text-text-300.font-medium'));
      var timePattern=/^\d{2}\/\d{2} \d{2}:\d{2}:\d{2}$/;
      for(var ti=0;ti<timeCandidates.length;ti++){var tt=clean((timeCandidates[ti].textContent||'').trim());var m=tt.match(timePattern);if(m){ timeLabel=m[0]; break; }}
      if(!timeLabel){var flexes=[].slice.call(row.querySelectorAll('.flex'));for(var fi=0;fi<flexes.length;fi++){var ft=clean((flexes[fi].textContent||'').trim());var mm=ft.match(timePattern);if(mm){ timeLabel=mm[0]; break; }}}
      if(!addr&&!tx&&!action)continue;
      out.push({time:timeLabel,action:action,price:priceText,amount:amountText,value:valueText,address:addr,tx:tx})
    }
    return out
  }
  function parseAll(doc){return {addresses:parseAddresses(doc),txs:parseTxs(doc),records:parseRecords(doc)}}
  window.GMGNParser={parseAll:parseAll,parseRecords:parseRecords,parseAddresses:parseAddresses,parseTxs:parseTxs}
})();

