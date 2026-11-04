(function(){
  "use strict";
  const labels={PENDING:"追蹤中",HIT:"已觸及",STOPPED:"先停損",REVIEW:"待核對",UNAVAILABLE:"價位無效"};
  const price=v=>Number.isFinite(v)?v.toLocaleString("en-US",{maximumSignificantDigits:10}):"—";
  function el(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
  function detail(trade){
    const box=el("div",null,"target-detail");
    if(!trade.targets){box.append(el("small",trade.entry?"舊紀錄：無三段追蹤資料":"尚未成交"));return box;}
    for(const target of trade.targets){const row=el("div",null,"target-level");row.dataset.state=target.status==="PENDING"&&trade.recovery?.pending?"RECOVERING":target.status;
      const identity=el("span",null,"target-value");identity.append(el("span",target.label,"target-caption"),el("strong",price(target.price),"target-price"));
      row.append(identity,el("small",row.dataset.state==="RECOVERING"?"核對中":labels[target.status]));
      if(target.at)row.title=new Date(target.at).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",hour12:false});box.append(row);}
    return box;
  }
  function stats(container,trades){
    const data=window.TargetEngine.stats(trades);container.replaceChildren();
    for(const target of data.levels){const card=el("div",null,"target-stat");
      card.append(el("span",target.label+" · 1:"+target.rr),el("strong",target.rate==null?"—":target.rate.toFixed(1)+"%"),
        el("small","已觸及 "+target.hits+" / 已判定 "+target.resolved),el("small","先停損 "+target.stopped+" · 追蹤中 "+target.pending+" · 核對中 "+(target.recovering||0)+" · 待核對 "+target.review+(target.unavailable?" · 無效 "+target.unavailable:"")));container.append(card);}
    const help=el("p","觸及率＝已觸及 ÷（已觸及＋先停損）。以模擬成交價至原停損的距離為 1R，各目標依 tick 朝有利方向取整。TP1 後繼續追蹤 TP2／TP3，碰到原停損即結束剩餘目標；不移動停損、不分批出場。追蹤中、核對中、待核對及無效價位不列入分母；觸及率不是費後勝率。有效進場 "+data.eligible+" 筆；舊資料未追蹤 "+data.legacy+" 筆。", "target-help");container.append(help);
  }
  window.TargetView={detail,stats};
})();
