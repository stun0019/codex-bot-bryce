(function(){
 'use strict';
 const $=id=>document.getElementById(id);document.querySelectorAll('[data-month]').forEach(b=>b.hidden=true);$('monthUpdate').disabled=true;$('monthUpdate').textContent='新版尚無回測報告';$('monthCancel').hidden=true;$('quarterStatus').textContent='新版尚無回測資料。';$('quarterScope').textContent='方向只看4H MACD，15M順勢BOS、OB與Fib回抽；四段出場30%／20%／20%／30%。';for(const id of ['quarterSummary','quarterAccount','quarterProfiles','quarterTargets','quarterTrades','monthlyComparison','quarterAssumptions'])$(id).replaceChildren();
})();
