(function(root){
  'use strict';
  const definitions=[{type:'PERPETUAL',label:'加密永續'},{type:'TRADIFI_PERPETUAL',label:'TradFi 永續'}];
  function type(value){if(value?.item)return type(value.item);return(value?.contractType||value?.market?.contractType)==='TRADIFI_PERPETUAL'?'TRADIFI_PERPETUAL':'PERPETUAL';}
  function split(items){return definitions.map(g=>({...g,items:items.filter(x=>type(x)===g.type)})).filter(g=>g.items.length);}
  function heading(group){const h=root.document.createElement('h3');h.className='market-group-heading';h.dataset.marketType=group.type;const title=root.document.createElement('span'),count=root.document.createElement('small');title.textContent=group.label;count.textContent=String(group.items.length);h.append(title,count);return h;}
  const api={type,split,heading};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.MarketGroups=api;
})(typeof window!=='undefined'?window:globalThis);
