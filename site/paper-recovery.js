(function(root){
  "use strict";
  const AGE=48*3600000, validSymbol=s=>/^[A-Z0-9]+USDT$/.test(s);
  function failure(code,message,permanent=false,extra={}) { return Object.assign(new Error(message),{code,permanent,...extra}); }
  function cursor(row) {
    const id=Number(row?.a),at=Number(row?.T),price=Number(row?.p);
    if(!Number.isSafeInteger(id)||id<0||!Number.isSafeInteger(at)||at<=0||!(price>0)||!Number.isFinite(price))throw failure("BAD_DATA","聚合成交資料格式無效",true);
    return{id,at,price};
  }
  function createClient({fetcher=globalThis.fetch,clock=()=>Date.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),spacing=750,maxPages=20}={}){
    let nextAt=0,backoff=0;
    async function request(symbol,params,signal){
      if(!validSymbol(symbol))throw failure("BAD_SYMBOL","不支援的合約名稱",true);
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      if(clock()<backoff)throw failure("RATE_LIMIT","幣安限流，等待自動重試",false,{retryAt:backoff});
      const wait=nextAt-clock();if(wait>0)await sleep(wait);nextAt=clock()+spacing;
      if(signal?.aborted)throw new DOMException("Aborted","AbortError");
      const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,15000);
      signal?.addEventListener("abort",abort,{once:true});
      try{
        const query=new URLSearchParams({symbol,...params});
        const response=await fetcher("https://fapi.binance.com/fapi/v1/aggTrades?"+query,{signal:controller.signal,cache:"no-store"});
        if(response.status===429||response.status===418){const seconds=Number(response.headers?.get("Retry-After"));backoff=clock()+Math.max(60000,Number.isFinite(seconds)?seconds*1000:0);throw failure("RATE_LIMIT","幣安限流，等待自動重試",false,{retryAt:backoff});}
        const data=await response.json();if(!response.ok||!Array.isArray(data))throw failure("REQUEST_FAILED",data?.msg||"核對行情 HTTP "+response.status,[-1121,-1100,-1102].includes(Number(data?.code)));
        const rows=data.map(cursor);if(rows.some(row=>row.at>clock()+30000))throw failure("BAD_TIME","聚合成交時間超出合理範圍",true);return rows;
      }catch(error){if(controller.signal.aborted&&!signal?.aborted)throw failure("TIMEOUT","補查行情逾時，稍後自動重試");throw error;}
      finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);}
    }
    async function range(symbol,anchor,signal,onProgress=()=>{}){
      if(!anchor||!Number.isSafeInteger(anchor.id)||!(anchor.at>0)||!(anchor.price>0))throw failure("NO_CHECKPOINT","沒有可驗證的成交檢查點",true);
      if(clock()-anchor.at>=AGE-60000)throw failure("OUT_OF_RANGE","中斷時間超過可保證補查的 48 小時範圍",true);
      const recent=await request(symbol,{limit:"1"},signal),head=recent.at(-1);
      if(!head||head.id<anchor.id||head.at<anchor.at)throw failure("HEAD_BEHIND","最新聚合成交尚未追上檢查點");
      const headCheckedAt=clock(),rows=[];let from=anchor.id;
      for(let page=0;page<maxPages;page++){
        const batch=await request(symbol,{fromId:String(from),limit:"1000"},signal);
        if(!batch.length)throw failure("HISTORY_GAP","補查資料缺漏，保留待核對",true);
        for(const row of batch){
          if(row.id>head.id)break;
          if(row.id!==from||(rows.length&&row.at<rows.at(-1).at))throw failure("HISTORY_GAP","聚合成交編號缺漏或順序異常",true);
          if(!rows.length&&(row.at!==anchor.at||row.price!==anchor.price))throw failure("ANCHOR_MISMATCH","原檢查點與幣安歷史成交不符",true);
          rows.push(row);from++;
          if(row.id===head.id){if(row.at!==head.at||row.price!==head.price)throw failure("HEAD_MISMATCH","歷史與即時銜接點不符",true);onProgress({symbol,pages:page+1,rows:rows.length});return{symbol,anchor,head,headCheckedAt,rows,complete:true};}
        }
        onProgress({symbol,pages:page+1,rows:rows.length});
      }
      if(rows.length<2)throw failure("NO_PROGRESS","核對資料未前進，等待重試");
      return{symbol,anchor,head,headCheckedAt,rows,complete:false};
    }
    return{range,getBackoffUntil:()=>backoff};
  }
  function createCoordinator({model,client=createClient(),clock=()=>Date.now(),onChange=()=>{},onProgress=()=>{}}){
    const buffers=new Map();let running=null;
    function accept(quote){
      if(!quote||quote.kind!=="aggTrade"||!validSymbol(quote.nativeSymbol)||quote.pair.replace("-USDT","USDT")!==quote.nativeSymbol||!Number.isSafeInteger(quote.aggregateId)||!(quote.price>0))return false;
      const symbol=quote.nativeSymbol;if(!buffers.has(symbol))buffers.set(symbol,new Map());const buffer=buffers.get(symbol);
      buffer.set(quote.aggregateId,quote);while(buffer.size>5000)buffer.delete(buffer.keys().next().value);
      const changed=model.tick(symbol,quote.price,quote.timestamp,{aggregateId:quote.aggregateId});if(changed)onChange();return changed;
    }
    function drain(symbol){for(const q of [...(buffers.get(symbol)?.values()||[])].sort((a,b)=>a.aggregateId-b.aggregateId))model.tick(symbol,q.price,q.timestamp,{aggregateId:q.aggregateId});}
    function recover(signal){
      if(running)return running;
      running=(async()=>{
        const symbols=[...new Set(model.recoveryTasks(clock()).map(t=>t.symbol))];
        for(const symbol of symbols){
          if(signal?.aborted)throw new DOMException("Aborted","AbortError");
          const tasks=model.recoveryTasks().filter(t=>t.symbol===symbol);if(!tasks.length)continue;
          const anchor=tasks.reduce((a,t)=>t.checkpoint.id<a.id?t.checkpoint:a,tasks[0].checkpoint);
          try{const proof=await client.range(symbol,{...anchor},signal,onProgress);if(signal?.aborted)throw new DOMException("Aborted","AbortError");model.applyRecovery(proof,clock());drain(symbol);onChange(true);}
          catch(error){if(error.name==="AbortError")throw error;model.recoveryError(symbol,error,clock());onChange(true);}
        }
      })().finally(()=>{running=null;});return running;
    }
    return{accept,recover,get running(){return !!running;}};
  }
  const api={createClient,createCoordinator,cursor,failure};if(typeof module!=="undefined"&&module.exports)module.exports=api;root.PaperRecovery=api;
})(typeof window!=="undefined"?window:globalThis);
