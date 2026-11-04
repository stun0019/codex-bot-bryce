(function(){
  "use strict";
  const $=id=>document.getElementById(id),body=$("quarterRows"),status=$("quarterStatus");
  const fmt=n=>Number.isFinite(n)?n.toLocaleString("en-US",{maximumFractionDigits:2,minimumFractionDigits:2}):"—";
  function node(tag,text){const n=document.createElement(tag);if(text!=null)n.textContent=text;return n;}
  const picker=$("quarterFilter");let index=null,request=0;
  async function open(row){
    const ticket=++request;
    status.textContent="讀取 "+row.quarter+" · "+row.timeframeLabel+" 完整報告…";
    try{const response=await fetch(row.url,{cache:"no-cache"});if(!response.ok)throw new Error("HTTP "+response.status);const report=await response.json();if(ticket!==request)return;
      if(report.strategyVersion!==row.strategyVersion||report.config.rsiFilter!==(row.variant==="macd-rsi"))throw new Error("報告條件不一致");
      window.BacktestView.show(report);document.getElementById("btStatus").textContent="已載入預先完成的季度歷史回測";document.getElementById("btProgress").value=1;status.textContent="已載入 "+row.quarter+" · "+row.timeframeLabel+"；季度統計已預先完成，不需重新掃描。";
    }catch(error){if(ticket===request)status.textContent="季度報告讀取失敗："+error.message;}
  }
  function render(){
    if(!index)return;body.replaceChildren();const rows=index.reports.filter(r=>r.variant===picker.value);
    for(const row of rows){const tr=node("tr"),s=row.stats;for(const value of [row.quarter,row.timeframeLabel,s.closed,s.winRate==null?"—":fmt(s.winRate)+"%",fmt(s.netPnl),fmt(s.averageR),fmt(row.coverage)+"%"]){tr.append(node("td",value));}
      const cell=node("td"),button=node("button","查看");button.type="button";button.setAttribute("aria-label","查看 "+row.quarter+" "+row.timeframeLabel);button.addEventListener("click",()=>void open(row));cell.append(button);tr.append(cell);body.append(tr);}
    void open(rows.find(r=>r.quarter==="2026 Q3"&&r.profileId==="4h15m")||rows[0]);
  }
  picker.addEventListener("change",render);
  window.addEventListener("entry-filter-change",event=>{picker.value=event.detail.enabled?"macd-rsi":"macd";render();});
  (async()=>{
    try{const response=await fetch("research/index.json?v=macd-2",{cache:"no-cache"});if(!response.ok)throw new Error("HTTP "+response.status);index=await response.json();
      if(index.strategyVersion!==window.SmcEngine.VERSION||!Array.isArray(index.reports)||index.reports.length!==18)throw new Error("季度報告版本或數量不符");
      try{picker.value=localStorage.getItem("codex-smc-rsi-filter")==="true"?"macd-rsi":"macd";}catch{}render();
    }catch(error){status.textContent="季度統計尚無法讀取："+error.message;}
  })();
})();
