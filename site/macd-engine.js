(function(root){
  'use strict';
  const E=root.StrategyEngine||(typeof require==='function'?require('./strategy-engine.js'):null);
  const F=root.FibEntry||(typeof require==='function'?require('./fib-entry.js'):null);
  const VERSION=F.VERSION,PROFILES=Object.freeze({'4h15m':Object.freeze({id:'4h15m',label:'4H＋15M',high:'4h',low:'15m'})});
  const SETTINGS=Object.freeze({capital:100,riskFraction:.05,leverage:50,maxHoldMs:43200000});
  const clone=x=>JSON.parse(JSON.stringify(x));
  function ema(values,n){const out=Array(values.length).fill(null);if(values.length<n)return out;out[n-1]=values.slice(0,n).reduce((s,v)=>s+v,0)/n;for(let i=n;i<values.length;i++)out[i]=out[i-1]+(values[i]-out[i-1])*2/(n+1);return out;}
  function macd(bars){const closes=bars.map(b=>b.close),fast=ema(closes,12),slow=ema(closes,26),dif=closes.map((_,i)=>slow[i]===null?null:fast[i]-slow[i]),valid=dif.slice(25),smooth=ema(valid,9),signal=dif.map((_,i)=>i<25?null:smooth[i-25]);return{dif,signal};}
  function trend(bars){if(bars.length<34)return null;const rows=macd(bars.slice(-499)),dif=rows.dif.at(-1),signal=rows.signal.at(-1);return{dif,signal,histogram:dif-signal,direction:dif>0?'LONG':dif<0?'SHORT':null,at:bars.at(-1).closeTime+1};}
  function point(bars,side){if(bars.length<5)return null;const near=bars.slice(-5),center=near[2];if(![0,1,3,4].every(i=>side==='HIGH'?near[i].high<center.high:near[i].low>center.low))return null;return{side,price:side==='HIGH'?center.high:center.low,openTime:center.openTime,confirmedAt:near[4].closeTime+1,bars:clone(near)};}
  function divergence(bars){const source=bars.slice(-499),m=macd(source),high=[],low=[];for(let i=2;i<source.length-2;i++){const b=source[i],near=[source[i-2],source[i-1],source[i+1],source[i+2]],p={price:0,dif:m.dif[i],openTime:b.openTime,confirmedAt:source[i+2].closeTime+1};if(near.every(n=>n.high<b.high))high.push({...p,price:b.high});if(near.every(n=>n.low>b.low))low.push({...p,price:b.low});}
    const pair=(rows,kind)=>{const a=rows.at(-2),b=rows.at(-1);if(!a||!b||a.dif===null||b.dif===null)return{state:'INSUFFICIENT',points:[]};return{state:(kind==='BOTTOM'?b.price<a.price&&b.dif>a.dif:b.price>a.price&&b.dif<a.dif)?'DIVERGENCE':'NONE',points:[a,b]};};const bottom=pair(low,'BOTTOM'),top=pair(high,'TOP');return{timeframe:'4H',bottom,top,state:bottom.state==='DIVERGENCE'&&top.state==='DIVERGENCE'?'BOTH':bottom.state==='DIVERGENCE'?'BULLISH':top.state==='DIVERGENCE'?'BEARISH':bottom.state==='INSUFFICIENT'||top.state==='INSUFFICIENT'?'INSUFFICIENT':'NONE',at:source.at(-1)?.closeTime+1};
  }
  function check(b,previous,d){if(!b||![b.openTime,b.closeTime,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite)||b.openTime%d||b.closeTime!==b.openTime+d-1||b.low<=0||b.low>Math.min(b.open,b.close)||b.high<Math.max(b.open,b.close)||b.volume<0||(previous&&b.openTime!==previous.openTime+d))throw Error('K線格式錯誤或不連續');}
  function createAnalyzer(id='4h15m'){
    if(!PROFILES[id])throw Error('只使用4H＋15M');
    const high=[],low=[],highPoints=[],lowPoints=[];let bias=null,highDivergence=null;
    const setups={LONG:null,SHORT:null};
    const reasons={LONG:'等待15M結構',SHORT:'等待15M結構'};
    function buildPlan(setup,market){if(!setup?.endpoint||!setup.stopStructure||!setup.readyTrend)return null;const readyAt=Math.max(setup.endpoint.confirmedAt,setup.readyTrend.at),c={symbol:market.symbol,strategyVersion:VERSION,strategyName:'4H MACD＋15M BOS／OB／Fib',profileId:'4h15m',timeframeLabel:'4H＋15M',direction:setup.direction,setupId:'bos-'+setup.bos.openTime+'-'+setup.endpoint.openTime+'-fib-limit',confirmedAt:readyAt,expiresAt:F.NO_EXPIRY,entryType:'LIMIT',targetMode:'FIB',partialExit:true,targetCount:4,exitFractions:[...F.FRACTIONS],riskFraction:.05,capital:100,tickSize:market.tickSize,market:{...market},macdDivergence:clone(highDivergence),fibSetup:clone(setup)};const p=F.prices(c.fibSetup,c.direction,c.tickSize);Object.assign(c,{entry:p.entry,stopLoss:p.stopLoss,target:p.target,targets:p.targets,entryLocation:p.entryLocation,fibEntry:p.fibEntry});return F.valid(c)?c:null;}
    function pushHigh(b){check(b,high.at(-1),14400000);high.push(clone(b));if(high.length>499)high.shift();bias=trend(high);highDivergence=divergence(high);}
    function pushLow(b,market=null){
      check(b,low.at(-1),900000);if(bias?.at>b.closeTime+1)throw Error('大框架資料晚於小框架');
      const at=b.closeTime+1,previous=low.at(-1),direction=bias?.direction||null;
      low.push(clone(b));if(low.length>499)low.shift();const hp=point(low,'HIGH'),lp=point(low,'LOW');if(hp)highPoints.push(hp);if(lp)lowPoints.push(lp);for(const points of[highPoints,lowPoints])while(points.length&&points[0].openTime<low[0].openTime)points.shift();
      for(const side of ['LONG','SHORT']){
        const direction=side;
        let setup=setups[side],lastReason=reasons[side];
        const broken=(direction==='LONG'?highPoints:lowPoints).filter(p=>!p.closedBrokenAt&&p.confirmedAt<=b.openTime&&previous&&(direction==='LONG'?previous.close<=p.price&&b.close>p.price&&b.close>b.open:previous.close>=p.price&&b.close<p.price&&b.close<b.open)).at(-1);
        if(setup){const long=setup.direction==='LONG';
          if(setup.readyTrend&&bias?.direction!==setup.direction){setup=null;lastReason='4H MACD方向改變，取消舊掛單';}
          else if(long?b.low<=setup.ob.low:b.high>=setup.ob.high){setup=null;lastReason='價格突破OB遠端，波段失效';}
          else if(setup.endpoint){const p=F.prices(setup,setup.direction,market?.tickSize||setup.tickSize);if(long?b.high>=p.target:b.low<=p.target){setup=null;lastReason='進場前已觸及第一目標，等待新波段';}
          }
          if(setup&&!setup.endpoint){setup.afterBos.push(clone(b));const endpoint=long?hp:lp;
            if(endpoint&&endpoint.openTime>=setup.bos.openTime){const peak=long?Math.max(setup.bos.high,...setup.afterBos.filter(x=>x.openTime<=endpoint.openTime).map(x=>x.high)):Math.min(setup.bos.low,...setup.afterBos.filter(x=>x.openTime<=endpoint.openTime).map(x=>x.low));
              if(endpoint.price===peak){setup.endpoint=clone(endpoint);setup.stopStructure=clone((long?lowPoints:highPoints).filter(p=>p.openTime<setup.bos.openTime&&p.confirmedAt<=at).at(-1)||null);
                const priorTurn=(long?highPoints:lowPoints).findLast(p=>
                  p.openTime<setup.bos.openTime&&p.confirmedAt<=setup.bos.openTime);
                const waveStart=Math.max(setup.broken.openTime,priorTurn?.openTime??0);
                const originPoints=(long?lowPoints:highPoints).filter(p=>
                  p.openTime>waveStart&&p.openTime<setup.bos.openTime&&p.confirmedAt<=at);
                setup.fibOrigin=clone(originPoints.reduce((best,p)=>
                  !best||(long?p.price<best.price:p.price>best.price)?p:best,null));
                const p=setup.stopStructure&&setup.fibOrigin?F.prices(setup,setup.direction,market?.tickSize||setup.tickSize):null;
                if(!p||setup.afterBos.filter(x=>x.openTime>endpoint.openTime).some(x=>long?x.low<=p.entry:x.high>=p.entry)){setup=null;lastReason='波段確認前已回抽進場價，不補掛單';}
              }
            }
          }
        }
        // Only a newly crossed, previously confirmed structure can create a new wave.
        if(bias&&broken&&previous){const long=direction==='LONG',ob=low.slice(0,-1).findLast(x=>long?x.close<x.open:x.close>x.open);
          if(ob&&(long?b.low>ob.low:b.high<ob.high)){setup={direction,anchorMode:'WAVE_FIB_LIMIT',ob:clone(ob),bos:clone(b),previous:clone(previous),broken:clone(broken),bosTrend:clone(bias),readyTrend:null,endpoint:null,stopStructure:null,leg:clone(low.filter(x=>x.openTime>=ob.openTime)),afterBos:[],tickSize:market?.tickSize||.00000001};lastReason='BOS成立，等待新波段高／低點右側2根確認';}
        }
        if(setup?.endpoint&&!setup.readyTrend&&bias?.direction===direction)setup.readyTrend=clone(bias);
        setups[side]=setup;
        reasons[side]=lastReason;
      }
      const setup=setups[direction],lastReason=reasons[direction];
      const pending=market?buildPlan(setup,market):null;
      for(const p of highPoints)if(!p.closedBrokenAt&&p.confirmedAt<=b.openTime&&b.close>p.price)p.closedBrokenAt=at;for(const p of lowPoints)if(!p.closedBrokenAt&&p.confirmedAt<=b.openTime&&b.close<p.price)p.closedBrokenAt=at;
      const status=!direction?'NO_DIRECTION':pending?'CANDIDATE':setup?.endpoint?'WAIT_PLAN':setup?'WAIT_PIVOT':'WATCH';
      const reason=!direction?'等待4H DIF離開零軸':pending?'等待回抽 Fib 0.715 限價':setup&&!setup.endpoint?'BOS成立，等待新波段轉折確認':lastReason;
      return{candidate:pending,pending,status,reason,direction,trend:clone(bias),divergence:clone(highDivergence),confirmedAt:at,lastClose:b.close,recentHigh:clone(highPoints.at(-1)||null),recentLow:clone(lowPoints.at(-1)||null),setup:setup?{bosAt:setup.bos.closeTime+1,ob:{low:setup.ob.low,high:setup.ob.high},state:setup.endpoint?'READY':'WAIT_PIVOT'}:null};
    }
    return{pushHigh,pushLow};
  }
  function analyze(market,higher,lower,asOf,capital=100,id='4h15m'){
    if(!PROFILES[id]||!Number.isFinite(asOf))throw Error('週期或掃描時間無效');for(const[bars,d]of[[higher,14400000],[lower,900000]])if(!Array.isArray(bars)||!bars.length||bars.at(-1).closeTime!==Math.floor(asOf/d)*d-1)throw Error('需要最新已收盤K線');
    const a=createAnalyzer(id);let h=0,result={pending:null,direction:null};for(const b of lower){while(h<higher.length&&higher[h].closeTime<=b.closeTime)a.pushHigh(higher[h++]);result=a.pushLow(b,market);}return result;
  }
  const api={MODE:'LIMIT_ENTRY',VERSION,PROFILES,SETTINGS,macd,trend,divergence,createAnalyzer,analyze,valid:F.valid,validTrade:F.validTrade,planAt:F.planAt,deadline:F.deadline,isVersion:v=>v===VERSION};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.MacdStrategy=api;
})(typeof window!=='undefined'?window:globalThis);
