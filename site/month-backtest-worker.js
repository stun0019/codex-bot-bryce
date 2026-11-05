'use strict';
importScripts('strategy-engine.js?v=body-2','account-risk.js?v=body-2','smc-engine.js?v=body-2','ema-engine.js?v=body-2','bos-legacy.js?v=body-2','bos-engine.js?v=body-2','macd-legacy.js?v=body-2','macd-engine.js?v=body-2','fib-engine.js?v=body-2','target-engine.js?v=body-2','paper-engine.js?v=body-2','macd-backtest.js?v=body-2');
let running=false,nextAt=0;
const progress=text=>postMessage({type:'progress',text});
async function candles(symbol,interval,start,end){let cursor=start,rows=[];const d=StrategyEngine.INTERVALS[interval];cursor=Math.floor(cursor/d)*d;
 while(cursor<end){const wait=nextAt-Date.now();if(wait>0)await new Promise(r=>setTimeout(r,wait));nextAt=Date.now()+300;
 const response=await fetch('https://fapi.binance.com/fapi/v1/klines?symbol='+encodeURIComponent(symbol)+'&interval='+interval+'&limit=1000&startTime='+cursor+'&endTime='+(end-1),{signal:AbortSignal.timeout(20000),cache:'no-store'});
 if(response.status===429||response.status===418)throw Error('Binance限流，請稍後再更新；既有結果未被覆寫');const data=await response.json();if(!response.ok||!Array.isArray(data))throw Error(data.msg||'歷史行情讀取失敗');if(!data.length)break;
 rows.push(...data.filter(r=>r[0]>=cursor&&r[6]<end));const next=Number(data.at(-1)[0])+d;if(next<=cursor)throw Error('歷史資料時間無進展');cursor=next;
 }return rows;
}
onmessage=async event=>{if(running)return;running=true;try{const{month,universe}=event.data;if(!['2026-08','2026-09','2026-10'].includes(month)||!Array.isArray(universe.markets)||universe.markets.length!==20)throw Error('回測月份或樣本無效');
 const start=Date.parse(month+'-01T00:00:00+08:00'),end=Date.parse('2026-'+String(Number(month.slice(5))+1).padStart(2,'0')+'-01T00:00:00+08:00'),datasets={},events=[],signalCoverage=[];
 for(let i=0;i<universe.markets.length;i++){const market=universe.markets[i],series={};for(const interval of ['4h','15m','5m']){progress('下載 '+(i+1)+'/20 '+market.symbol+' '+interval);series[interval]=await candles(market.symbol,interval,start-(interval==='4h'?90:interval==='15m'?20:0)*86400000,end);}
 progress('計算 '+market.symbol+' 實體BOS訊號');events.push(...MacdBacktest.signals(market,series,start,end));datasets[market.symbol]={'5m':series['5m']};signalCoverage.push({symbol:market.symbol,highBars:series['4h'].length,lowBars:series['15m'].length});}
 progress('行情下載完成，重播帳戶與分批出場…');const report=MacdBacktest.run({markets:universe.markets,datasets,events,start,end,capital:200,strategyVersion:MacdStrategy.VERSION});
 if(report.coverage.some(c=>c.percent<100))throw Error('執行行情不完整，本次不保存績效');Object.assign(report,{month,id:'macd-body-'+month,createdAt:Date.now(),rankingAsOf:universe.rankingAsOf,symbols:universe.markets.map(m=>m.symbol),signalCoverage,scope:'固定2026年11月Top20樣本，非當時歷史排名，有選樣與存活者偏差。以當前實體BOS規則手動重算。'});
 report.assumptions.unshift('BOS必須當根開盤在結構內、收盤在結構外；影線及跳空不算。','每月獨立200 USDT；結果保存於此瀏覽器，不影響模擬持倉。');postMessage({type:'done',report});
 }catch(error){postMessage({type:'error',text:error.message});}finally{running=false;}};
