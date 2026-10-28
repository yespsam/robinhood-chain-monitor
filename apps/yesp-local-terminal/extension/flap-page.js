// Reads only the selected mini-app's rendered address cards. Page content is a
// display hint; the native reader independently checks its market/CA binding.
(() => {
  const address = text => /^0x[\da-f]{40}$/i.test(text||'') && !/^0x0{40}$/i.test(text) ? text : null;
  const labels = new Map([
    ['market address','market'],['market 地址','market'],['市场地址','market'],['市場地址','market'],
    ['predicted token address','predicted'],['预测代币地址','predicted'],['預測代幣地址','predicted'],
    ['token address','token'],['代币地址','token'],['代幣地址','token']
  ]);
  const clean = text => String(text||'').replace(/\s+/g,' ').trim();
  function visible(node) {
    for(let current=node;current;current=current.parentElement||current.getRootNode?.().host){
      if(current.hidden||current.getAttribute?.('aria-hidden')==='true'||current.style?.display==='none'||current.style?.visibility==='hidden')return false;
    }
    return typeof node.getClientRects!=='function'||node.getClientRects().length>0;
  }
  function rootsWithin(root) {
    const roots=[root],seen=new Set(roots);for(let i=0;i<roots.length&&i<30;i++)for(const node of [roots[i],...(roots[i].querySelectorAll?.('*')||[])])if(node.shadowRoot&&!seen.has(node.shadowRoot)){seen.add(node.shadowRoot);roots.push(node.shadowRoot);}
    return roots;
  }
  function read(doc=document) {
    const candidates=[];
    for(const root of rootsWithin(doc))for(const app of root.querySelectorAll?.('[data-standalone-mini-app="agent-bonding-curve"]')||[]){
      for(const scope of rootsWithin(app)){
        const records=[];
        for(const node of scope.querySelectorAll?.('p, span')||[]){
          if(!visible(node)||node.children?.length)continue;
          const kind=labels.get(clean(node.textContent).toLowerCase());if(!kind)continue;
          // Both official normal-terminal and just-created cards place the full
          // address next to a small label/header, never in a global address list.
          let card=node.parentElement;
          for(let depth=0;card&&depth<3;depth++,card=card.parentElement){
            const values=[...card.querySelectorAll('p')].filter(visible).map(n=>address(clean(n.textContent))).filter(Boolean);
            const distinct=[...new Set(values.map(x=>x.toLowerCase()))];
            if(distinct.length===1){records.push({kind,value:values[0],card});break;}
            if(distinct.length>1)break;
          }
        }
        const markets=records.filter(r=>r.kind==='market'),tokens=records.filter(r=>r.kind!=='market');
        for(const market of markets)for(const token of tokens){
          if(market.card.parentElement!==token.card.parentElement||market.value.toLowerCase()===token.value.toLowerCase())continue;
          const headings=[...scope.querySelectorAll('h1')].filter(visible);
          candidates.push({marketAddress:market.value,tokenAddress:token.value,predicted:token.kind==='predicted',name:clean(headings.at(-1)?.textContent).slice(0,100)});
        }
      }
    }
    const unique=new Map(candidates.map(x=>[x.marketAddress.toLowerCase()+':'+x.tokenAddress.toLowerCase(),x]));
    return unique.size===1?[...unique.values()][0]:null;
  }
  globalThis.YespFlapPage=Object.freeze({read});
})();
