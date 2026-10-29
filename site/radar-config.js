// Static candidate universe, not a claim to cover every BingX perpetual contract.
window.CodexRadarConfig = Object.freeze({
  universe: [
    "BTC-USDT", "ETH-USDT", "SOL-USDT", "BNB-USDT", "XRP-USDT",
    "DOGE-USDT", "ADA-USDT", "AVAX-USDT", "LINK-USDT", "DOT-USDT",
    "LTC-USDT", "BCH-USDT", "TRX-USDT", "ETC-USDT", "XLM-USDT",
    "ATOM-USDT", "NEAR-USDT", "UNI-USDT", "APT-USDT", "ARB-USDT",
    "OP-USDT", "SUI-USDT", "SEI-USDT", "INJ-USDT", "FIL-USDT",
    "ICP-USDT", "AAVE-USDT", "PEPE-USDT", "WIF-USDT", "BONK-USDT",
    "SHIB-USDT", "FLOKI-USDT", "FET-USDT", "ENA-USDT", "ZEC-USDT",
    "HBAR-USDT", "TON-USDT", "TAO-USDT", "ONDO-USDT", "WLD-USDT",
    "JUP-USDT", "TIA-USDT", "STX-USDT", "IMX-USDT", "GALA-USDT",
    "SAND-USDT", "MANA-USDT", "EOS-USDT", "CRV-USDT", "MKR-USDT"
  ],
  weights: Object.freeze({
    liquidity: 0.20,
    spread: 0.20,
    volatility: 0.20,
    relativeStrength: 0.25,
    momentum: 0.15
  }),
  liquidityBottomPercentile: 0.20,
  minMarketsForLiquidityFilter: 10,
  maxSpreadPct: 0.50, // Initial scanner safeguard, not a BingX official limit.
  biasThresholdPct: 0.50,
  relativeStrengthScalePct: 3,
  momentumScalePct: 1.5,
  scoreIntervalMs: 1500,
  rankHysteresisPoints: 2,
  topCount: 10,
  tickerStaleMs: 20000,
  bookStaleMs: 10000,
  historyMaxMs: 330000,
  historyToleranceMs: 15000
});
