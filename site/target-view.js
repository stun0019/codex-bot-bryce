(function(){
  "use strict";
  const labels={PENDING:"追蹤中",HIT:"已觸及",STOPPED:"先出場",REVIEW:"待核對",UNAVAILABLE:"價位無效"};
  const price=v=>Number.isFinite(v)?v.toLocaleString("en-US",{maximumSignificantDigits:10}):"—";
  function el(tag,text,className){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(className)n.className=className;return n;}
  function detail(trade){
    const box=el("div",null,"target-detail");
    if(!trade.targets){if(trade.plannedTargets){trade.plannedTargets.forEach((p,i)=>{const row=el("div",null,"target-level"),v=el("span",null,"target-value");v.append(el("span","TP"+(i+1)+(trade.targetMode==="FIB"?" · "+["20%","30%","30%","20%"][i]:""),"target-caption"),el("strong",price(p),"target-price"));row.append(v,el("small",trade.status==="WAITING_PRICE"?"待限價觸及":"未成交"));box.append(row);});}else box.append(el("small",trade.entry?"舊紀錄：無目標追蹤資料":"尚未成交"));return box;}
    for(const target of trade.targets){const row=el("div",null,"target-level");row.dataset.state=target.status==="PENDING"&&trade.recovery?.pending?"RECOVERING":target.status;
      const identity=el("span",null,"target-value");identity.append(el("span",target.label+(trade.targetMode==="FIB"?" · "+["20%","30%","30%","20%"][Number(target.label.slice(2))-1]:""),"target-caption"),el("strong",price(target.price),"target-price"));
      row.append(identity,el("small",row.dataset.state==="RECOVERING"?"核對中":labels[target.status]));
      if(target.at)row.title=new Date(target.at).toLocaleString("zh-TW",{timeZone:"Asia/Taipei",hour12:false});box.append(row);}
    return box;
  }
  function stats(container,trades,options={}){
    const data=window.TargetEngine.stats(trades,options);container.replaceChildren();
    for(const target of data.levels){const card=el("div",null,"target-stat");
      card.append(el("span",target.label+(target.mode==="FIB"?" · Fib "+target.fibLevel:target.mode==="MIXED"?" · 混合目標":" · 1:"+target.rr)),el("strong",target.rate==null?"—":target.rate.toFixed(1)+"%"),
        el("small","已觸及 "+target.hits+" / 已判定 "+target.resolved),el("small","先出場 "+target.stopped+" · 追蹤中 "+target.pending+" · 核對中 "+(target.recovering||0)+" · 待核對 "+target.review+(target.unavailable?" · 無效 "+target.unavailable:"")+(target.untracked?" · 未追蹤 "+target.untracked:"")));container.append(card);}
    const help=el("p","觸及率＝已觸及 ÷（已觸及＋先出場）。新Fib目標為0／−0.27／−0.618／−1，分批20%／30%／30%／剩餘20%。達TP後，剩餘部位回撤上一個已達TP則全出；未達目標列先出場。舊紀錄沿用原固定R目標及出場規則。追蹤中、核對中、待核對及無效價位不列入分母；觸及率不是費後勝率。有效進場 "+data.eligible+" 筆；舊資料未追蹤 "+data.legacy+" 筆。", "target-help");container.append(help);
  }
  function paperSummary(container,{account,stats:performance,trades}){
    const data=window.TargetEngine.stats(trades),money=value=>Number.isFinite(value)?value.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}):"—";
    const percent=(value,signed=false)=>Number.isFinite(value)?(signed&&value>0?"+":"")+money(value)+"%":"—";
    const card=(label,value,caption,tone,title)=>{
      const box=el("div",null,"paper-summary-card"),amount=el("strong",value,"paper-summary-value");box.dataset.tone=tone;box.title=title||label;
      box.append(el("span",label,"paper-summary-label"),amount,el("small",caption,"paper-summary-caption"));container.append(box);
    };
    container.replaceChildren();
    card("累積盈虧",percent(account?.returnPct,true),account?"策略淨損益 "+(account.periodPnl>0?"+":"")+money(account.periodPnl)+" USDT":"等待帳戶初始化",account?.returnPct<0?"negative":"yellow","所選策略費後已實現與可確認未實現損益相對初始資金；待核對時不估算報酬");
    card("策略勝率",percent(performance.winRate),performance.wins+" 勝 / "+performance.losses+" 敗 · "+performance.closed+" 筆","positive","依目前週期篩選，費後淨獲利的已平倉筆數÷全部已平倉筆數");
    for(const level of data.levels)card(level.label+" 觸及率",percent(level.rate),level.hits+" / "+level.resolved+" 筆已判定","positive",level.label+" 已觸及÷（已觸及＋先出場）；"+(level.label==="TP4"?"新Fib出最後20%；舊策略僅觀察":"未進場、追蹤中與待核對不列入分母"));
  }
  window.TargetView={detail,stats,paperSummary};
})();
