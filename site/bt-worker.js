importScripts("strategy-engine.js?v=tp-1","target-engine.js?v=recovery-1","paper-engine.js?v=recovery-1","bt-engine.js?v=tp-1");
self.onmessage=event=>{
  try {const report=BacktestEngine.run(event.data,progress=>self.postMessage({type:"progress",progress}));self.postMessage({type:"result",report});}
  catch(error){self.postMessage({type:"error",message:error.message});}
};
