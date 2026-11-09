(function (root) {
  "use strict";
  const Engine = root.StrategyEngine || (typeof require === "function" ? require("./strategy-engine.js") : null);
  const Targets = root.TargetEngine || (typeof require === "function" ? require("./target-engine.js") : null);
  const Account = root.AccountRisk || (typeof require === "function" ? require("./account-risk.js") : null);
  const Single=root.SmcEntry||(typeof require==='function'?require('./smc-entry.js'):null);
  const single=trade=>Single.isSingle(trade);
  const manualOnly=()=> (root.MacdStrategy||(typeof require==='function'?require('./macd-engine.js'):null))?.MODE==='CANDIDATES_ONLY';
  const smc=single;
  const hasExpired=(trade,at)=>!Single.isFib(trade)&&at>=trade.expiresAt;
  const partial=t=>Single.isFib(t)&&t.partialExit,timed=t=>Single.isIntraday(t);
  const strategy=()=>root.MacdStrategy||(typeof require==='function'?require('./macd-engine.js'):null),current=t=>strategy().isVersion(t?.strategyVersion);
  const DEFAULTS = Object.freeze({ enabled: true, feeRate: 0.0005, slippage: 0.0002 });
  const ACTIVE = new Set(["WAITING_PRICE", "OPEN"]), CLOSED = new Set(["TAKE_PROFIT", "STOP_LOSS", "TIME_EXIT"]);
  const STATUSES = new Set([...ACTIVE, ...CLOSED, "SKIPPED", "REVIEW"]);
  const MAX_GAP_MS = 30000;
  function settings(value = {}) {
    const valid = number => typeof number === "number" && Number.isFinite(number) && number >= 0 && number <= 0.01;
    return { enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULTS.enabled,
      feeRate: valid(value.feeRate) ? value.feeRate : DEFAULTS.feeRate,
      slippage: valid(value.slippage) ? value.slippage : DEFAULTS.slippage };
  }
  const finite = value => typeof value === "number" && Number.isFinite(value);
  const key = candidate => candidate.symbol + ":" + candidate.direction + ":" + candidate.confirmedAt + (candidate.strategyVersion ? ":" + candidate.strategyVersion + ":" + candidate.profileId + ":" + candidate.setupId : "");

  function createModel(saved = null) {
    if (saved && (saved.version !== 1 || !Array.isArray(saved.trades))) throw new Error("模擬紀錄格式無法讀取");
    const config = settings(saved?.settings), trades = saved ? JSON.parse(JSON.stringify(saved.trades)) : [];
    const ignoreBefore = saved?.ignoreBefore ?? 0;
    if (!finite(ignoreBefore) || ignoreBefore < 0) throw new Error("模擬紀錄清空時間無效");
    const seen = new Set();
    for (const trade of trades) {
      if (!trade || !single(trade) || !validSmc(trade) || (trade.checkpoint !== undefined && !validCursor(trade.checkpoint)) || (trade.recovery?.pending && (!validCursor(trade.checkpoint) || !hasWork(trade))) || !Targets.valid(trade) || !STATUSES.has(trade.status) || !/^[A-Z0-9]+USDT$/.test(trade.symbol) ||
          !["LONG", "SHORT"].includes(trade.direction) || trade.id !== key(trade) || seen.has(trade.id) ||
          !finite(trade.detectedAt) || !finite(trade.confirmedAt) || !finite(trade.expiresAt) ||
          !(trade.stopLoss > 0) || !(trade.target > 0) || !(trade.tickSize > 0) || !(trade.capital > 0) ||
          !trade.market || !(trade.market.stepSize > 0) || !finite(trade.feeRate) || !finite(trade.slippage) ||
          trade.feeRate < 0 || trade.feeRate > 0.01 || trade.slippage < 0 || trade.slippage > 0.01 ||
          ((trade.status === "OPEN" || CLOSED.has(trade.status)) &&
            (!(trade.entry > 0) || !(trade.quantity > 0) || !finite(trade.entryFee) || !finite(trade.openedAt))) ||
          (CLOSED.has(trade.status) && (!finite(trade.netPnl) || !finite(trade.closedAt)))) throw new Error("模擬紀錄含無效或重複資料");
      seen.add(trade.id);
    }
    let account = saved?.account ? Account.validate(saved.account, trades) : null;
    for (const trade of trades) if (trade.accountId && (!account || trade.accountId !== account.id || !validReservedPlan(trade))) throw new Error("共用帳戶預留計畫無效");
    function enableAccount(capital = 100, at = Date.now(), limits = Account.DEFAULTS) {
      if (account) return false;
      for (const trade of trades) if (trade.status === "WAITING_PRICE") skip(trade, "升級共用帳戶，舊待成交計畫不回填；等待新掃描預留", at);
      account = Account.create(trades, capital, at, limits); return true;
    }
    function startStrategySession(capital=100,at=Date.now()){
      if(account?.strategyVersion===strategy().VERSION)return false;
      for(const t of trades)if(t.status==='WAITING_PRICE')skip(t,'策略更換，取消舊待成交計畫',at);
      if(account){account.strategyVersion=strategy().VERSION;return true;}
      const previous=account;account=Account.create(trades,capital,at,previous?.limits||Account.DEFAULTS);
      if(previous)account.id=previous.id;account.strategyVersion=strategy().VERSION;return true;
    }
    function applyFunding(symbol,rows,checkedAt){
      if(!Array.isArray(rows)||!finite(checkedAt))throw Error('資金費率資料無效');let changed=false;
      for(const t of trades)if(timed(t)&&t.symbol===symbol&&t.entry>0){
        t.fundingFills=t.fundingFills||[];const seen=new Set(t.fundingFills.map(f=>f.at));
        for(const f of rows){const at=Number(f.fundingTime),rate=Number(f.fundingRate),mark=Number(f.markPrice);if(!finite(at)||!finite(rate)||!(mark>0))throw Error('資金費率欄位無效');if(at<=t.openedAt||at>checkedAt||(t.closedAt&&at>t.closedAt)||seen.has(at))continue;
          const quantity=Single.isFib(t)?t.quantity-(t.exitFills||[]).filter(fill=>fill.at<at).reduce((sum,fill)=>sum+fill.quantity,0):t.quantity;t.fundingFills.push({at,rate,mark,quantity,amount:mark*quantity*rate*(t.direction==='LONG'?1:-1)});seen.add(at);changed=true;
        }
        t.fundingPaid=t.fundingFills.reduce((sum,f)=>sum+f.amount,0);t.fundingCheckedAt=checkedAt;changed=true;
        if(CLOSED.has(t.status))t.netPnl=t.realizedGross-t.entryFee-t.realizedExitFees-t.fundingPaid;
      }return changed;
    }
    function accountState(at = Date.now(), excludeId = null) { return account ? Account.metrics(trades, account, at, excludeId) : null; }
    const priority = (a, b) => (Number(b.market?.quoteVolume24h) || 0) - (Number(a.market?.quoteVolume24h) || 0) || (a.profileId === b.profileId ? 0 : a.profileId === "4h15m" ? -1 : 1) || a.symbol.localeCompare(b.symbol) || a.confirmedAt - b.confirmedAt;
    function validReservedPlan(trade) {
      const plan = trade.reservedPlan;
      if (!plan || !plan.ok || plan.accountId !== trade.accountId || !(plan.quantity > 0)) return false;
      const candidate = { ...trade, entry: trade.referenceEntry, targets: trade.plannedTargets };
      if(single(trade))Object.assign(candidate,Single.planAt(candidate,fill(trade,trade.referenceEntry,true)));
      const expected = Engine.position(candidate, trade.market, trade.capital, { entry: trade.entryType==="MARKET_NEXT"?fill(trade,trade.referenceEntry,true):trade.referenceEntry, budget: trade.budget, riskFraction: smc(trade) ? .05 : .03, feeRate: trade.feeRate, slippage: trade.slippage, partialExit: partial(trade), leverage: plan.leverage, quantity: plan.quantity });
      return expected.ok && ["entry", "quantity", "risk", "entryFee", "stopExitFee", "initialMargin", "feeReserve", "marginReserve", "budget"].every(k => finite(plan[k]) && Math.abs(plan[k] - expected[k]) <= 1e-8 * Math.max(1, Math.abs(expected[k])));
    }
    function previewCandidates(candidates, capital = 200, at = Date.now()) {
      const result = new Map(), extra = [];
      if(manualOnly())return new Map(candidates.map(c=>[key(c),{ok:false,reason:"目前只列候選，進場由你自行判斷"}]));
      for (const candidate of [...candidates].sort(priority)) {
        if(['STRUCTURE_ENTRY','LIMIT_ENTRY'].includes(strategy().MODE)&&!current(candidate)){result.set(key(candidate),{ok:false,reason:'舊策略不再新增'});continue;}
        const id = key(candidate), recorded = trades.find(t => t.id === id); let plan;
        if (recorded) {
          plan = recorded.status === "WAITING_PRICE" && recorded.reservedPlan ? { ...recorded.reservedPlan, status: "RESERVED", reason: "已預留；成交前重新核驗" } :
            recorded.status === "OPEN" ? { ...(recorded.executionPlan || recorded.reservedPlan), ok: true, status: "OPEN", quantity: recorded.quantity, reason: "已進場，原始數量已固定" } : { ok: false, status: recorded.status, reason: recorded.reason || "此計畫已結束" };
          const state = accountState(at); if (recorded.status === "WAITING_PRICE" && state?.blockedReason) plan = { ...plan, ok: false, status: "BLOCKED", reason: state.blockedReason };
        } else if (candidate.confirmedAt <= ignoreBefore || hasExpired(candidate,at)) plan = { ok: false, reason: "此訊號已清空或到期" };
        else if (!config.enabled) plan = { ok: false, reason: "已暫停新增" };
        else if (account) {
          plan = Account.plan(candidate, config, Account.metrics([...trades, ...extra], account, at));
          if (plan.ok) extra.push({ id, symbol: candidate.symbol, direction: candidate.direction, status: "WAITING_PRICE", reservedPlan: plan });
        } else plan = Engine.position(candidate, candidate.market, capital, config);
        result.set(id, plan);
      }
      return result;
    }
    function enforceAccount(at = Date.now()) {
      if (!account) return false; let changed = false;
      for (const trade of trades.filter(t => t.status === "WAITING_PRICE" && t.accountId === account.id).sort(priority).reverse()) {
        const state = accountState(at); if (!state.blockedReason) break;
        skip(trade, state.blockedReason, at); changed = true;
      }
      return changed;
    }
    function skip(trade, reason, at) { trade.status = "SKIPPED"; trade.reason = reason; trade.resolvedAt = at; }
    function review(trade, reason, at) {
      Targets.interrupt(trade, reason, at);
      if (trade.status === "WAITING_PRICE") skip(trade, reason, at);
      else if (trade.status === "OPEN") { trade.status = "REVIEW"; trade.reason = reason; trade.reviewAt = at; }
    }
    function fill(trade, price, entering) {
      const buying = (trade.direction === "LONG") === entering;
      return Engine.quantize(price * (buying ? 1 + trade.slippage : 1 - trade.slippage), trade.tickSize, buying ? "ceil" : "floor");
    }
    function addCandidates(candidates, capital, now) {
      if (manualOnly() || !config.enabled || !(capital > 0) || !finite(capital)) return 0;
      let added = 0;
      if (account) enforceAccount(now);
      for (const candidate of (account ? [...candidates].sort(priority) : candidates)) {
        if (!candidate || !Single.valid(candidate) || (['STRUCTURE_ENTRY','LIMIT_ENTRY'].includes(strategy().MODE)&&!current(candidate)) || !/^[A-Z0-9]+USDT$/.test(candidate.symbol) || !["LONG", "SHORT"].includes(candidate.direction) ||
            !finite(candidate.confirmedAt) || candidate.confirmedAt <= ignoreBefore || !finite(candidate.expiresAt) || candidate.confirmedAt > now || hasExpired(candidate,now) ||
            !(candidate.stopLoss > 0) || !(candidate.target > 0) || !(candidate.tickSize > 0) ||
            !(candidate.market?.stepSize > 0) || seen.has(key(candidate))) continue;
        const reservedPlan = account ? Account.plan(candidate, config, accountState(now)) : null;
        if (account && !reservedPlan.ok) continue;
        const trade = { id: key(candidate), symbol: candidate.symbol, direction: candidate.direction,
          confirmedAt: candidate.confirmedAt, detectedAt: now, expiresAt: candidate.expiresAt,
          referenceEntry: candidate.entry, stopLoss: candidate.stopLoss, target: candidate.target,
          strategyVersion:candidate.strategyVersion,profileId:candidate.profileId,timeframeLabel:candidate.timeframeLabel,setupId:candidate.setupId,entryType:candidate.entryType,strategyName:candidate.strategyName,targetMode:candidate.targetMode,...(candidate.fibSetup?{fibSetup:JSON.parse(JSON.stringify(candidate.fibSetup)),exitFractions:[...candidate.exitFractions],entryLocation:candidate.entryLocation,fibEntry:candidate.fibEntry,macdDivergence:JSON.parse(JSON.stringify(candidate.macdDivergence||null))}:candidate.intradayEntry?{intradayEntry:JSON.parse(JSON.stringify(candidate.intradayEntry))}:{smcEntry:JSON.parse(JSON.stringify(candidate.smcEntry))}),partialExit:!!candidate.partialExit,targetCount:candidate.targetCount,riskFraction:.05,plannedTargets:[...candidate.targets],entryFilter:{enabled:false},
          ...(reservedPlan ? { accountId: account.id, reservedPlan: { ...reservedPlan } } : {}),
          tickSize: candidate.tickSize, capital: reservedPlan ? reservedPlan.capital : capital, budget: reservedPlan ? reservedPlan.budget : capital * (candidate.strategyVersion ? .05 : 0.03),
          market: { ...candidate.market }, feeRate: config.feeRate, slippage: config.slippage,
          status: "WAITING_PRICE", reason: current(candidate)?"等待限價觸價":"15M SMC回踩確認，等待下一筆新成交報價" };
        trades.push(trade); seen.add(trade.id); added++;
      }
      return added;
    }
    function open(trade, price, at, frozenState=null) {
      const entry = trade.entryType==="MARKET_NEXT"?fill(trade,price,true):smc(trade) ? trade.referenceEntry : fill(trade, price, true), long = trade.direction === "LONG";
      if (!(entry > 0) || (long ? entry <= trade.stopLoss : entry >= trade.stopLoss)) {
        skip(trade, "進場報價已越過停損或目標", at); return;
      }
      const proposed=Single.planAt(trade,entry);
      const distance = Math.abs(entry - trade.stopLoss), rr = Math.abs(proposed.target - entry) / distance;
      if (rr <= 0 || (!current(trade) && rr < 2)) { skip(trade, "實際模擬進場的價差盈虧比不足 1:2", at); return; }
      const candidate = { ...trade, ...proposed, targets: proposed.targets };
      const plan = Engine.position(candidate, trade.market, trade.capital, { entry, budget: trade.budget, riskFraction: smc(trade) ? .05 : .03, feeRate: trade.feeRate, slippage: trade.slippage,
        partialExit: partial(trade), leverage: trade.reservedPlan?.leverage || 50, ...(trade.reservedPlan ? { quantity: trade.reservedPlan.quantity } : {}) });
      if (!plan.ok) { skip(trade, plan.reason, at); return; }
      if (account) {
        const reason = Account.canOpen(plan, frozenState||accountState(at, trade.id), trade.direction, price);
        if (reason) { skip(trade, reason, at); return; }
      }
      const quantity = plan.quantity;trade.stopLoss=proposed.stopLoss;trade.target=proposed.target;trade.plannedTargets=proposed.targets;trade.executionPlan = { ...plan };
      if (smc(trade)) {
        trade.remainingQuantity = quantity; trade.realizedGross = 0; trade.realizedExitFees = 0; trade.exitFills = [];
        trade.exitLegs = plan.exitQuantities.map((quantity, i) => ({ label: "TP" + (i + 1), price: trade.plannedTargets[i], quantity, status: "PENDING" }));
      }
      trade.targets = Targets.createSingle({...trade,entry}); trade.targetsLastQuoteAt = at;
      Object.assign(trade, { status: "OPEN", reason: "連續追蹤中", entry, quantity, openedAt: at,
        observedEntry: price, entryFee: entry * quantity * trade.feeRate,
        estimatedStopRisk: plan.risk, entryRewardRisk: rr, lastPrice: price, lastQuoteAt: at });
    }
    function netAt(trade, price) {
      if (smc(trade) && finite(trade.remainingQuantity)) {
        const exit = fill(trade, price, false), remaining = trade.remainingQuantity;
        const gross = trade.realizedGross + (exit - trade.entry) * remaining * (trade.direction === "LONG" ? 1 : -1);
        const exitFee = trade.realizedExitFees + exit * remaining * trade.feeRate;
        const average = remaining === 0 && trade.exitFills.length ? trade.exitFills.reduce((sum, f) => sum + f.price * f.quantity, 0) / trade.quantity : exit;
        return { exit: average, gross, exitFee, net: gross - trade.entryFee - exitFee - (trade.fundingPaid||0) };
      }
      const exit = fill(trade, price, false), gross = (exit - trade.entry) * trade.quantity * (trade.direction === "LONG" ? 1 : -1);
      return { exit, gross, exitFee: exit * trade.quantity * trade.feeRate,
        net: gross - trade.entryFee - exit * trade.quantity * trade.feeRate };
    }
    function validSmc(trade){return Single.validTrade(trade);}
    function executeSingle(t,price,at,source){
      if(t.status!=="OPEN")return false;
      const long=t.direction==="LONG",stop=long?price<=t.stopLoss:price>=t.stopLoss,hit=long?price>=t.target:price<=t.target;
      const due=timed(t)&&at>=Single.deadline(t),timeLabel=due?(Single.deadline(t)===t.openedAt+43200000?'TIME_12H':'DAY_FLAT'):null;
      t.lastPrice=price;t.lastQuoteAt=at;if(!due&&!stop&&!hit)return false;
      const observed=!due&&!stop&&hit?t.target:price,result=netAt(t,observed),label=due?timeLabel:stop?'STOP':'TP1';
      t.exitFills=[{label,quantity:t.quantity,price:result.exit,fee:result.exitFee,at,source}];t.remainingQuantity=0;t.realizedGross=result.gross;t.realizedExitFees=result.exitFee;t.exitLegs[0].status=label==='TP1'?'FILLED':'CANCELLED';if(label==='TP1')t.exitLegs[0].at=at;
      if(due)for(const target of t.targets||[])if(target.status==='PENDING')Object.assign(target,{status:'EXITED',at,reason:timeLabel});
      Object.assign(t,{status:due?'TIME_EXIT':stop?'STOP_LOSS':'TAKE_PROFIT',closedAt:at,exit:result.exit,observedExit:price,grossPnl:result.gross,exitFee:result.exitFee,netPnl:result.net,exitReason:label,exitSource:source,reason:due?(timeLabel==='DAY_FLAT'?'台北午夜日內平倉':'最長持有12小時平倉'):stop?'觸及停損，全部出場':t.intradayEntry?'觸及15M結構目標，全部出場':'觸及2R目標，全部出場'});return true;
    }
    function executeFib(t,price,at,source){
      if(t.status!=='OPEN')return false;const long=t.direction==='LONG',due=at>=Single.deadline(t),stop=long?price<=t.stopLoss:price>=t.stopLoss;
      t.lastPrice=price;t.lastQuoteAt=at;let changed=false;
      function legExit(quantity,observed,label,index=null){const exit=index===null?fill(t,observed,false):observed,gross=(exit-t.entry)*quantity*(long?1:-1),fee=exit*quantity*t.feeRate;
        t.realizedGross+=gross;t.realizedExitFees+=fee;t.remainingQuantity=Number((t.remainingQuantity-quantity).toFixed(Engine.decimals(t.market.stepSize)));t.exitFills.push({label,quantity,price:exit,fee,at,source});
        if(index!==null){t.exitLegs[index].status='FILLED';t.exitLegs[index].at=at;Object.assign(t.targets[index],{status:'HIT',at,observedPrice:price});}changed=true;
      }
      if(due||stop){const label=due?(Single.deadline(t)===t.openedAt+43200000?'TIME_12H':'DAY_FLAT'):'STOP';legExit(t.remainingQuantity,price,label);for(const leg of t.exitLegs)if(leg.status==='PENDING')leg.status='CANCELLED';for(const target of t.targets)if(target.status==='PENDING')Object.assign(target,{status:due?'EXITED':'STOPPED',at});}
      else for(let i=0;i<t.exitLegs.length;i++){const leg=t.exitLegs[i];if(leg.status==='PENDING'&&(long?price>=leg.price:price<=leg.price))legExit(leg.quantity,leg.price,leg.label,i);}
      if(t.remainingQuantity===0){const last=t.exitFills.at(-1);Object.assign(t,{status:due?'TIME_EXIT':stop?'STOP_LOSS':'TAKE_PROFIT',closedAt:at,exit:t.exitFills.reduce((sum,f)=>sum+f.price*f.quantity,0)/t.quantity,observedExit:price,grossPnl:t.realizedGross,exitFee:t.realizedExitFees,netPnl:t.realizedGross-t.entryFee-t.realizedExitFees-(t.fundingPaid||0),exitReason:last.label,exitSource:source,reason:due?'日內時間平倉':stop?'結構停損，剩餘部位出場':'Fib四段止盈完成'});}
      else if(changed)t.reason='分批止盈中，剩餘 '+Math.round(t.remainingQuantity/t.quantity*100)+'%';return changed;
    }
    function executeSmc(trade,price,at,source="live"){return Single.isFib(trade)?executeFib(trade,price,at,source):executeSingle(trade,price,at,source);}
    function tryLimitFill(trade, price, at, frozenState=null) {
      if(manualOnly()){if(trade.status==="WAITING_PRICE")skip(trade,"已改為主觀進場，不再自動成交",at);return false;}
      if (!smc(trade) || trade.status !== "WAITING_PRICE" || !(price > 0) || !finite(price) || !finite(at) || at < trade.detectedAt) return false;
      const long = trade.direction === "LONG";
      if (hasExpired(trade,at)) skip(trade, "進場候選到期", at);
      else if (long ? price <= trade.stopLoss : price >= trade.stopLoss) skip(trade, "進場前已越過停損或 TP1", at);
      else if (trade.entryType==="MARKET_NEXT" || (long ? price <= trade.referenceEntry : price >= trade.referenceEntry)) open(trade, price, at, frozenState);
      return trade.status !== "WAITING_PRICE";
    }
    function recordLimitFill(candidate, capital, at) {
      if (!Single.valid(candidate) || candidate.entryType !== "LIMIT" || candidate.confirmedAt <= ignoreBefore) return false;
      const id = key(candidate);
      let trade = trades.find(t => t.id === id);
      if (!trade) {
        addCandidates([candidate], capital, at);
        trade = trades.find(t => t.id === id);
      }
      if (!trade || trade.entry || !["WAITING_PRICE", "SKIPPED"].includes(trade.status)) return false;
      const next = { ...trade, status: "WAITING_PRICE" };
      if (trade.status === "SKIPPED" && account) {
        const plan = Account.plan(candidate, config, accountState(at, id));
        if (!plan.ok) return false;
        Object.assign(next, { reservedPlan: plan, capital: plan.capital, budget: plan.budget, feeRate: plan.feeRate, slippage: plan.slippage });
      }
      if (!tryLimitFill(next, candidate.entry, at) || next.status !== "OPEN") return false;
      if (!next.checkpoint) next.awaitingInitialQuote = true;
      delete next.resolvedAt;
      delete trade.resolvedAt;
      Object.assign(trade, next);
      return true;
    }
    function resumeRecordedFill(trade, at) {
      if (trade.status === "OPEN" && !trade.checkpoint && !trade.awaitingInitialQuote) {
        trade.awaitingInitialQuote = true;
        return true;
      }
      if (trade.status !== "REVIEW" || trade.checkpoint || !trade.openedAt ||
          trade.exitFills?.length || !trade.reason?.startsWith("缺少成交編號")) return false;
      Object.assign(trade, { status: "OPEN", awaitingInitialQuote: true, targets: Targets.createSingle(trade),
        targetsLastQuoteAt: at, reason: "已記錄成交，等待首筆行情" });
      delete trade.reviewAt;
      return true;
    }
    function cancelOrder(trade, reason, at) { if (trade.status === "WAITING_PRICE") { skip(trade, reason, at); return true; } return false; }
    function reconcileCandidates(candidates, observations, at) {
      const ids = new Set(candidates.map(key)), checked = new Set(observations.filter(o => o.status !== "ERROR").map(o => o.symbol + ":" + o.profileId)); let changed = false;
      for (const trade of trades) if (smc(trade) && trade.status === "WAITING_PRICE" && checked.has(trade.symbol + ":" + trade.profileId) && !ids.has(trade.id)) { skip(trade, "已收盤 K 線確認候選失效／已回測，不回填成交", at); changed = true; }
      return changed;
    }
    function hasWork(trade) { return trade.status === "OPEN" || Targets.pending(trade); }
    function validCursor(cursor) { return cursor && Number.isSafeInteger(cursor.id) && cursor.id >= 0 && finite(cursor.at) && cursor.at > 0 && finite(cursor.price) && cursor.price > 0; }
    function queueRecovery(trade, reason, at) {
      if (trade.status === "WAITING_PRICE") { skip(trade, "追蹤已中斷，不回填過期進場", at); return true; }
      if (!hasWork(trade) || trade.recovery?.pending || (trade.awaitingInitialQuote && !trade.checkpoint)) return false;
      if (!validCursor(trade.checkpoint)) { review(trade, "缺少成交編號，無法自動核對：" + reason, at); return true; }
      trade.recovery = { ...trade.recovery, pending: true, state: "PENDING", reason, requestedAt: at, nextRetryAt: 0, attempts: 0, lastError: "" }; return true;
    }
    function suspend(reason, at, symbol = null) {
      let changed = false;
      for (const trade of trades) if ((!symbol || trade.symbol === symbol) && queueRecovery(trade, reason, at)) changed = true;
      return changed;
    }
    function recoveryTasks(at = Infinity) {
      return trades.filter(t => t.recovery?.pending && hasWork(t) && validCursor(t.checkpoint) && (t.recovery.nextRetryAt || 0) <= at);
    }
    function recoveryError(symbol, error, at) {
      for (const trade of recoveryTasks()) if (trade.symbol === symbol) {
        const rec = trade.recovery;
        Object.assign(rec, { attempts: (rec.attempts || 0) + 1, lastError: error.message, errorCode: error.code || "NETWORK", lastAttemptAt: at });
        if (error.permanent) {
          rec.resumePrimary = trade.status === "OPEN"; rec.resumeTargets = (trade.targets || []).map((t,i) => t.status === "PENDING" ? i : -1).filter(i => i >= 0);
          review(trade, "自動核對未完成：" + error.message, at); rec.pending = false; rec.state = "REVIEW";
        } else { rec.state = "RETRY"; rec.nextRetryAt = Math.max(error.retryAt || 0, at + Math.min(300000, 5000 * 2 ** Math.min(rec.attempts, 6))); }
      }
    }
    function retryRecovery(at) {
      let changed = false;
      for (const trade of trades) if (validCursor(trade.checkpoint) && trade.recovery) {
        const rec = trade.recovery;
        if (rec.state === "REVIEW") {
          if (rec.resumePrimary && trade.status === "REVIEW") { trade.status = "OPEN"; delete trade.reviewAt; }
          for (const index of rec.resumeTargets || []) { const target = trade.targets?.[index]; if (target?.status === "REVIEW") { target.status = "PENDING"; delete target.at; delete target.reason; } }
        }
        if (hasWork(trade) && (rec.pending || rec.state === "REVIEW")) { Object.assign(rec,{pending:true,state:"PENDING",nextRetryAt:0,requestedAt:at}); changed = true; }
      }
      return changed;
    }
    function observe(trade, price, at, source) {
      if(timed(trade)&&trade.status==="OPEN"&&at>=Single.deadline(trade)){executeSmc(trade,price,at,source);return;}
      if (Targets.pending(trade)) { const pending = trade.targets.filter(t => t.status === "PENDING"); Targets.quote(trade, price, at); for (const target of pending) if (target.status !== "PENDING") target.source = source; trade.targetsLastQuoteAt = at; }
      if (trade.status !== "OPEN") return;
      if (smc(trade)) { executeSmc(trade, price, at, source); return; }
      trade.lastPrice = price; trade.lastQuoteAt = at;
      const long = trade.direction === "LONG", stopped = long ? price <= trade.stopLoss : price >= trade.stopLoss;
      const targeted = long ? price >= trade.target : price <= trade.target;
      if (!stopped && !targeted) return;
      const result = netAt(trade, price);
      Object.assign(trade, { status: stopped ? "STOP_LOSS" : "TAKE_PROFIT", closedAt: at, exit: result.exit,
        observedExit: price, grossPnl: result.gross, exitFee: result.exitFee, netPnl: result.net, exitSource: source,
        reason: source === "reconciled" ? "歷史聚合成交核對確認出場" : stopped ? "即時成交報價觸及停損" : "即時成交報價觸及目標" });
    }
    function applyRecovery(proof, at) {
      const { symbol, anchor, head, rows, complete } = proof || {};
      if (proof?.headCheckedAt !== undefined && (!finite(proof.headCheckedAt) || proof.headCheckedAt > at + 30000 || proof.headCheckedAt < head?.at - 30000)) throw new Error("核對銜接時間無效");
      if (!/^[A-Z0-9]+USDT$/.test(symbol) || !validCursor(anchor) || !validCursor(head) || !Array.isArray(rows) || !rows.length || head.id < anchor.id || head.at < anchor.at) throw new Error("核對資料格式無效");
      const same = (a,b) => a.id === b.id && a.at === b.at && a.price === b.price;
      if (!same(rows[0],anchor) || rows.some((row,i) => !validCursor(row) || row.id > head.id || (i && (row.id !== rows[i-1].id+1 || row.at < rows[i-1].at))) ||
          (complete ? !same(rows.at(-1),head) : rows.at(-1).id >= head.id)) throw new Error("核對成交編號不連續或銜接點不符");
      const replacements = [];
      for (const trade of recoveryTasks()) if (trade.symbol === symbol) {
        const cursor = trade.checkpoint, index = cursor.id - anchor.id;
        if (index >= rows.length) continue;
        if (index < 0 || !same(rows[index],cursor)) throw new Error("持倉檢查點與核對行情不符");
        const next = JSON.parse(JSON.stringify(trade));
        for (let i=index+1;i<rows.length;i++) {
          const row=rows[i]; observe(next,row.price,row.at,"reconciled"); next.checkpoint={...row};
          if (!hasWork(next)) break;
        }
        const finished = complete || !hasWork(next);
        next.recovery = { ...next.recovery, pending: !finished, state: finished ? "DONE" : "PENDING", nextRetryAt: finished ? 0 : at+1000,
          lastCheckedAt: finished ? (Number.isFinite(proof.headCheckedAt) ? proof.headCheckedAt : head.at) : next.recovery.lastCheckedAt, lastVerifiedAt: next.checkpoint.at, finishedAt: finished ? at : null, recovered: true, lastError: "" };
        if (next.status === "OPEN") next.reason = finished ? "核對完成，已恢復即時追蹤" : "已核對部分行情，繼續補查";
        replacements.push([trade,next]);
      }
      for (const [trade,next] of replacements) Object.assign(trade,next);
      if (account) enforceAccount(at);
      return replacements.length > 0;
    }

    function tick(symbol, price, at, metadata = {}) {
      if (!(price > 0) || !finite(price) || !finite(at)) return false;
      let changed = false;
      for (const trade of trades) {
        if (trade.symbol !== symbol || (!ACTIVE.has(trade.status) && !Targets.pending(trade)) || at < trade.detectedAt || at < (trade.lastQuoteAt || 0)) continue;
        if (trade.recovery?.pending) continue;
        const hasId = Number.isSafeInteger(metadata.aggregateId) && metadata.aggregateId >= 0;
        if (trade.status === "OPEN" && trade.awaitingInitialQuote && !trade.checkpoint) {
          if (!hasId) continue;
          delete trade.awaitingInitialQuote;
          observe(trade, price, at, "live");
          trade.checkpoint = { id: metadata.aggregateId, at, price };
          changed = true;
          continue;
        }
        if (trade.checkpoint) {
          if (!hasId || metadata.aggregateId <= trade.checkpoint.id) continue;
          if (metadata.aggregateId !== trade.checkpoint.id + 1 || at - Math.max(trade.checkpoint.at, trade.recovery?.lastCheckedAt || 0) > MAX_GAP_MS) { queueRecovery(trade, "成交序列中斷，等待自動核對", at); changed = true; continue; }
        }
        if (trade.status === "WAITING_PRICE" && manualOnly()){skip(trade,"已改為主觀進場，不再自動成交",at);changed=true;continue;}
        if (trade.status === "WAITING_PRICE" && smc(trade)) {
          const long = trade.direction === "LONG";
          if (hasExpired(trade,at) || at - (trade.lastQuoteAt || trade.detectedAt) > MAX_GAP_MS) skip(trade, "進場候選到期或行情中斷；不回填進場", at);
          else if (long ? price <= trade.stopLoss || price >= trade.target : price >= trade.stopLoss || price <= trade.target) skip(trade, "進場前已越過停損或 TP1", at);
          else if(trade.entryType==="MARKET_NEXT"||(long?price<=trade.referenceEntry:price>=trade.referenceEntry))open(trade, price, at);
          trade.lastQuoteAt = at;
          if (hasId && (trade.status === "WAITING_PRICE" || trade.status === "OPEN")) trade.checkpoint = { id: metadata.aggregateId, at, price };
          changed = true; continue;
        }
        if (trade.status === "WAITING_PRICE") {
          if (at >= Math.min(trade.expiresAt, trade.detectedAt + MAX_GAP_MS)) skip(trade, "未及時取得新成交報價", at);
          else { open(trade, price, at); if (trade.status === "OPEN" && hasId) trade.checkpoint = { id: metadata.aggregateId, at, price }; }
          changed = true; continue; // The fill tick cannot also close its newly opened trade.
        }
        if (hasId && trade.checkpoint) { observe(trade, price, at, "live"); trade.checkpoint = { id: metadata.aggregateId, at, price }; changed = true; continue; }
        if (Targets.pending(trade)) {
          if (at < trade.targetsLastQuoteAt) continue;
          if (at - trade.targetsLastQuoteAt > MAX_GAP_MS) Targets.interrupt(trade, "2R目標報價中斷，需核對", at);
          else { Targets.quote(trade, price, at); trade.targetsLastQuoteAt = at; }
          changed = true;
        }
        if (trade.status !== "OPEN") continue;
        if (at - trade.lastQuoteAt > MAX_GAP_MS) { review(trade, "報價追蹤中斷，期間觸價順序需核對", at); changed = true; continue; }
        trade.lastPrice = price; trade.lastQuoteAt = at; changed = true;
        if (smc(trade)) { executeSmc(trade, price, at, "live"); continue; }
        const long = trade.direction === "LONG";
        const stopped = long ? price <= trade.stopLoss : price >= trade.stopLoss;
        const targeted = long ? price >= trade.target : price <= trade.target;
        if (!stopped && !targeted) continue;
        const result = netAt(trade, price);
        Object.assign(trade, { status: stopped ? "STOP_LOSS" : "TAKE_PROFIT", closedAt: at,
          exit: result.exit, observedExit: price, grossPnl: result.gross, exitFee: result.exitFee,
          netPnl: result.net, reason: stopped ? "即時成交報價觸及停損" : "即時成交報價觸及目標" });
      }
      if (account && enforceAccount(at)) changed = true;
      return changed;
    }
    function interrupt(reason, at) {
      let changed = false;
      for (const trade of trades) { if (Targets.interrupt(trade, reason, at)) changed = true; if (ACTIVE.has(trade.status)) { review(trade, reason, at); changed = true; } }
      return changed;
    }
    function expire(now) {
      let changed = account ? enforceAccount(now) : false;
      for (const trade of trades) {
        if (trade.recovery?.pending || (trade.awaitingInitialQuote && !trade.checkpoint)) continue;
        if (trade.status === "WAITING_PRICE" && smc(trade)) {
          if (hasExpired(trade,now) || now - (trade.lastQuoteAt || trade.detectedAt) > MAX_GAP_MS) { skip(trade, "進場候選到期或行情中斷；不回填進場", now); changed = true; }
          continue;
        }
        if (trade.status === "WAITING_PRICE" && now >= Math.min(trade.expiresAt, trade.detectedAt + MAX_GAP_MS)) { skip(trade, "未及時取得新成交報價", now); changed = true; }
        else if (trade.checkpoint && hasWork(trade) && now - Math.max(trade.checkpoint.at, trade.recovery?.lastCheckedAt || 0) > MAX_GAP_MS) { if (queueRecovery(trade, "超過 30 秒未取得成交，等待自動核對", now)) changed = true; }
        else if (!trade.checkpoint) {
          if (Targets.pending(trade) && now - trade.targetsLastQuoteAt > MAX_GAP_MS) { Targets.interrupt(trade, "2R目標超過 30 秒無報價，需核對", now); changed = true; }
          if (trade.status === "OPEN" && now - trade.lastQuoteAt > MAX_GAP_MS) { review(trade, "超過 30 秒未取得成交報價，需核對", now); changed = true; }
        }
      }
      return changed;
    }
    function stats(profileId = "all") {
      const cohort=trades.filter(t=>single(t)&&(profileId!=="current"||current(t)));
      const closed = cohort.filter(trade => CLOSED.has(trade.status)).sort((a,b) => a.closedAt - b.closedAt || a.id.localeCompare(b.id));
      const wins = closed.filter(trade => trade.netPnl > 0).length;
      let pnl = 0, peak = 0, maxDrawdown = 0, streak = 0, maxLossStreak = 0;
      for (const trade of closed) {
        pnl += trade.netPnl; peak = Math.max(peak, pnl); maxDrawdown = Math.max(maxDrawdown, peak - pnl);
        streak = trade.netPnl < 0 ? streak + 1 : 0; maxLossStreak = Math.max(maxLossStreak, streak);
      }
      const byDirection = direction => { const rows = closed.filter(t => t.direction === direction); return { count: rows.length,
        winRate: rows.length ? rows.filter(t => t.netPnl > 0).length / rows.length * 100 : null }; };
      return { recovering: cohort.filter(t => t.recovery?.pending).length, reconciledClosed: closed.filter(t => t.exitSource === "reconciled").length, continuousClosed: closed.filter(t => t.exitSource !== "reconciled").length, legacyReview: cohort.filter(t => !t.checkpoint && (t.status === "REVIEW" || t.targets?.some(level => level.status === "REVIEW"))).length, targets: Targets.stats(cohort,{targetMode:"SINGLE"}), closed: closed.length, wins, losses: closed.filter(t => t.netPnl < 0).length,
        winRate: closed.length ? wins / closed.length * 100 : null, netPnl: pnl,
        averagePnl: closed.length ? pnl / closed.length : null, maxDrawdown, maxLossStreak,
        open: cohort.filter(t => t.status === "OPEN" && !t.recovery?.pending).length, waiting: cohort.filter(t => t.status === "WAITING_PRICE").length,
        skipped: cohort.filter(t => t.status === "SKIPPED").length, review: cohort.filter(t => t.status === "REVIEW").length,
        long: byDirection("LONG"), short: byDirection("SHORT") };
    }
    return { trades, settings: config, enableAccount, startStrategySession, applyFunding, accountState, previewCandidates, enforceAccount, accountSnapshot: () => account ? JSON.parse(JSON.stringify(account)) : null, addCandidates, tick, interrupt, expire, stats, netAt, executeSmc, tryLimitFill, recordLimitFill, resumeRecordedFill, cancelOrder, reconcileCandidates, suspend, recoveryTasks, recoveryError, retryRecovery, applyRecovery,
      activeSymbols: () => [...new Set(trades.filter(t => ACTIVE.has(t.status) || Targets.pending(t)).map(t => t.symbol))],
      snapshot: () => ({ version: 1, settings: { ...config }, trades, ...(ignoreBefore > 0 ? { ignoreBefore } : {}), ...(account ? { account: JSON.parse(JSON.stringify(account)) } : {}) }) };
  }
  const api = { createModel, DEFAULTS, MAX_GAP_MS, CLOSED, key };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PaperEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
