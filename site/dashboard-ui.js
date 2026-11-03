(function(){
  "use strict";
  const $=id=>document.getElementById(id),panels=[...document.querySelectorAll('[data-desk-panel]')];
  const routes={overview:'signals',signals:'signals',paperTitle:'paper',paper:'paper',backtest:'backtest',scans:'scans',scanArchiveTitle:'scans'};
  const number=n=>n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  function navigate(scroll=false){
    const name=routes[location.hash.slice(1)]||'signals';
    panels.forEach(panel=>{panel.hidden=panel.dataset.deskPanel!==name;});
    $('overviewSummary').hidden=name!=='signals';document.body.dataset.view=name;
    document.querySelectorAll('[data-desk-link]').forEach(link=>{if(link.dataset.deskLink===name)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
    if(scroll){if(location.hash==='#overview')window.scrollTo({top:0,behavior:'instant'});else panels.find(panel=>panel.dataset.deskPanel===name)?.scrollIntoView({block:'start',behavior:'instant'});}
  }
  window.DashboardUI={
    updateSummary(stats){
      $('deskNet').textContent=(stats.netPnl>0?'+':'')+number(stats.netPnl);$('deskNet').dataset.tone=stats.netPnl>0?'positive':stats.netPnl<0?'negative':'neutral';
      $('deskClosed').textContent=stats.closed+' 筆已平倉';$('deskWin').textContent=stats.winRate==null?'—':stats.winRate.toFixed(1)+'%';
      $('deskWins').textContent=stats.wins+' 勝 / '+stats.losses+' 敗';
      stats.targets.levels.forEach((level,index)=>{$('deskTP'+(index+1)).textContent=level.rate==null?'—':level.rate.toFixed(1)+'%';$('deskTPCount'+(index+1)).textContent=level.hits+' / '+level.resolved+' 筆已判定';});
      $('deskTracking').textContent=String(stats.open);$('deskWaiting').textContent=stats.waiting+' 待報價 · '+stats.review+' 待核對';
      $('deskPaperCount').textContent=String(stats.open+stats.waiting);
    },
    setCandidates(total){$('deskCandidateCount').textContent=String(total);}
  };
  window.addEventListener('hashchange',()=>navigate(true));navigate();
})();
