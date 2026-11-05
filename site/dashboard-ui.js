(function(){
  "use strict";
  const $=id=>document.getElementById(id),panels=[...document.querySelectorAll('[data-desk-panel]')];
  const routes={overview:'signals',signals:'signals',paperTitle:'paper',paper:'paper',backtestTitle:'backtest',backtest:'backtest',news:'news',newsTitle:'news'};
  const number=n=>n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
  function navigate(scroll=false){
    const name=routes[location.hash.slice(1)]||'signals';
    (name==='paper'?$('paperAccountSlot'):$('accountHomeSlot')).append($('sharedAccount'));
    panels.forEach(panel=>{panel.hidden=panel.dataset.deskPanel!==name;});
    $('sharedAccount').hidden=name==='backtest'||name==='news';document.body.dataset.view=name;
    document.querySelectorAll('[data-desk-link]').forEach(link=>{if(link.dataset.deskLink===name)link.setAttribute('aria-current','page');else link.removeAttribute('aria-current');});
    if(scroll){if(location.hash==='#overview')window.scrollTo({top:0,behavior:'instant'});else panels.find(panel=>panel.dataset.deskPanel===name)?.scrollIntoView({block:'start',behavior:'instant'});}
  }
  window.DashboardUI={
    updateSummary(stats){$('deskPaperCount').textContent=String(stats.open+stats.waiting+(stats.recovering||0));},
    setCandidates(total){$('deskCandidateCount').textContent=String(total);}
  };
  window.addEventListener('hashchange',()=>navigate(true));navigate();
})();
