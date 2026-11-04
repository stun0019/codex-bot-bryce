(function(root){
  "use strict";
  const E=root.StrategyEngine||(typeof require==="function"?require("./strategy-engine.js"):null);
  function createClient({store=root.LabStore,fetcher=root.fetch.bind(root),spacing=250,clock=()=>Date.now(),
    sleep=(ms,signal)=>new Promise((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException("Aborted","AbortError"));};
      const timer=setTimeout(()=>{signal?.removeEventListener("abort",abort);resolve();},ms);
      if(signal?.aborted)abort();else signal?.addEventListener("abort",abort,{once:true});})}={}){
    let nextAt=0;
    async function json(path,signal){
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      const at=Math.max(nextAt,clock());nextAt=at+spacing;
      if(at>clock())await sleep(at-clock(),signal);
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,15000);
      signal?.addEventListener("abort",abort,{once:true});
      try{
        const response=await fetcher("https://fapi.binance.com"+path,{signal:controller.signal,cache:"no-store"});
        if(response.status===429||response.status===418)throw new Error("幣安限流，已停止回測資料請求，請稍後重試");
        const data=await response.json();if(!response.ok||Number(data?.code)<0)throw new Error(data?.msg||"Binance HTTP "+response.status);
        return data;
      }catch(error){if(controller.signal.aborted&&!signal?.aborted)throw new Error("歷史行情請求逾時，請縮短期間或稍後重試");throw error;}
      finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
    }
    async function range(symbol,interval,start,end,signal,onPage=()=>{}){
      if(!/^[A-Z0-9]+USDT$/.test(symbol)||!Object.hasOwn(E.INTERVALS,interval))throw new Error("不支援的合約或 K 線週期");
      const duration=E.INTERVALS[interval],id=[symbol,interval,start,end].join(":");
      const saved=await store.get("series",id);if(saved){onPage({symbol,interval,cached:true});return saved;}
      const rows=[];let cursor=start;
      for(let page=0;cursor<end&&page<200;page++){
        const data=await json("/fapi/v1/klines?symbol="+encodeURIComponent(symbol)+"&interval="+interval+
          "&startTime="+Math.floor(cursor)+"&endTime="+Math.floor(end-1)+"&limit=499",signal);
        if(!Array.isArray(data))throw new Error(symbol+" 歷史回傳格式無效");
        if(!data.length)break;
        for(const raw of data){
          if(!Array.isArray(raw)||raw.length<7)throw new Error(symbol+" 歷史資料不完整");
          const row=raw.slice(0,8).map(Number);
          if(!row.slice(0,7).every(Number.isFinite))throw new Error(symbol+" 歷史資料含無效數值");
          if(row[0]>=start&&row[6]<end)rows.push(row);
        }
        const following=Number(data.at(-1)[0])+duration;
        if(!(following>cursor))throw new Error(symbol+" 歷史資料分頁未前進");
        cursor=following;onPage({symbol,interval,cached:false,rows:rows.length});
      }
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      if(!rows.length)throw new Error(symbol+" 沒有此期間的 "+interval+" 歷史資料");
      for(let i=0;i<rows.length;i++){
        const row=rows[i];
        if(row[0]%duration||row[6]!==row[0]+duration-1||!(row[3]>0)||row[2]<Math.max(row[1],row[4])||
          row[3]>Math.min(row[1],row[4])||(i&&row[0]!==rows[i-1][0]+duration))throw new Error(symbol+" 的 "+interval+" K 線缺漏或格式錯誤");
      }
      const expected=Math.floor(end/duration)*duration-1;
      if(rows.at(-1)[6]!==expected)throw new Error(symbol+" 的 "+interval+" 歷史尾端資料不足");
      const result={id,symbol,interval,start,end,rows,createdAt:clock()};await store.put("series",result);return result;
    }
    async function load(markets,config,signal,onProgress=()=>{}){
      const profiles=config.profileId&&config.profileId!=="both"?[config.profileId]:["4h15m","1h5m"],intervals=[...new Set(profiles.flatMap(id=>id==="4h15m"?["4h","15m"]:["1h","5m"]))];
      const datasets={},refs={},warmupStart=Math.floor((config.start-20*86400000)/E.INTERVALS["4h"])*E.INTERVALS["4h"];
      let completed=0;
      // Serial, rate-controlled retrieval also limits memory and network pressure on mobile.
      for(const market of markets){
        datasets[market.symbol]={};refs[market.symbol]={};
        for(const interval of intervals){
          const series=await range(market.symbol,interval,warmupStart,config.end,signal,page=>onProgress({...page,completed,total:markets.length*intervals.length}));
          datasets[market.symbol][interval]=series.rows;refs[market.symbol][interval]=series.id;
          completed++;onProgress({symbol:market.symbol,interval,completed,total:markets.length*intervals.length});
        }
      }
      return{datasets,refs};
    }
    return{range,load,json};
  }
  const api={createClient};if(typeof module!=="undefined"&&module.exports)module.exports=api;root.BacktestData=api;
})(typeof window!=="undefined"?window:globalThis);
