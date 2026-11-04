importScripts("strategy-engine.js?v=smc-1","smc-engine.js?v=1","target-engine.js?v=smc-1","paper-engine.js?v=smc-1","bt-engine.js?v=smc-1");
self.onmessage=event=>{try{const report=BacktestEngine.run(event.data,p=>self.postMessage({type:"progress",progress:p}));self.postMessage({type:"result",report});}catch(error){self.postMessage({type:"error",message:error.message});}};
