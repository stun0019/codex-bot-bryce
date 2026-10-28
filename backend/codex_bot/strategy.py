"""Provisional closed-candle OB/CHOCH detector for observation candidates."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from math import isfinite
from typing import Literal, Sequence

Side = Literal["LONG", "SHORT"]
PAIRS = {"H4/M15": ("4h", "15m"), "H1/M5": ("1h", "5m")}


@dataclass(frozen=True)
class Candle:
    open_ms: int
    close_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0

    def __post_init__(self) -> None:
        prices = (self.open, self.high, self.low, self.close)
        if self.open_ms >= self.close_ms or not all(isfinite(v) and v > 0 for v in prices):
            raise ValueError("Invalid candle time or price")
        if self.high < max(self.open, self.close) or self.low > min(self.open, self.close):
            raise ValueError("Invalid OHLC")
        if not isfinite(self.volume) or self.volume < 0:
            raise ValueError("Invalid volume")


@dataclass(frozen=True)
class StrategyConfig:
    swing_span: int = 2
    ob_lookback: int = 8

    def __post_init__(self) -> None:
        if self.swing_span < 1 or self.ob_lookback < 1:
            raise ValueError("Strategy parameters must be positive")


@dataclass(frozen=True)
class OrderBlock:
    low: float
    high: float
    candle_ms: int


@dataclass(frozen=True)
class Candidate:
    symbol: str
    pair: str
    side: Side
    formed_ms: int
    htf_retest_ms: int
    htf_ob: OrderBlock
    ltf_ob: OrderBlock
    choch_level: float
    strategy_version: str = "ob-choch-observe-v1"

    @property
    def key(self) -> str:
        return f"{self.strategy_version}:{self.symbol}:{self.pair}:{self.side}:{self.formed_ms}"

    def as_dict(self) -> dict:
        return {**asdict(self), "key": self.key, "state": "OBSERVING"}


def _pivots(candles: Sequence[Candle], span: int) -> tuple[list[int], list[int]]:
    highs, lows = [], []
    # A pivot becomes available only after its right-side candles have closed.
    for i in range(span, len(candles) - span):
        left, right = candles[i - span:i], candles[i + 1:i + span + 1]
        if all(candles[i].high > item.high for item in (*left, *right)):
            highs.append(i)
        if all(candles[i].low < item.low for item in (*left, *right)):
            lows.append(i)
    return highs, lows


def _trend(prior: Sequence[Candle], side: Side, config: StrategyConfig) -> tuple[bool, float | None]:
    highs, lows = _pivots(prior, config.swing_span)
    if len(highs) < 2 or len(lows) < 2:
        return False, None
    high_a, high_b = (prior[i].high for i in highs[-2:])
    low_a, low_b = (prior[i].low for i in lows[-2:])
    if side == "SHORT":
        return high_b < high_a and low_b < low_a, low_b
    return high_b > high_a and low_b > low_a, high_b


def _crosses(previous: Candle, candle: Candle, level: float, side: Side) -> bool:
    if side == "SHORT":
        return previous.close >= level > candle.close
    return previous.close <= level < candle.close


def _opposing(candle: Candle, side: Side) -> bool:
    return candle.close > candle.open if side == "SHORT" else candle.close < candle.open


def _ob_before(candles: Sequence[Candle], break_index: int, side: Side, lookback: int) -> OrderBlock | None:
    for i in range(break_index - 1, max(-1, break_index - lookback - 1), -1):
        candle = candles[i]
        if _opposing(candle, side):
            return OrderBlock(candle.low, candle.high, candle.open_ms)
    return None


def _invalidates(candle: Candle, ob: OrderBlock, side: Side) -> bool:
    return candle.close > ob.high if side == "SHORT" else candle.close < ob.low


def _touches(candle: Candle, ob: OrderBlock) -> bool:
    return candle.high >= ob.low and candle.low <= ob.high


def _htf_retests(candles: Sequence[Candle], side: Side, config: StrategyConfig):
    start = 2 * config.swing_span + 4
    for i in range(start, len(candles) - 1):
        trending, level = _trend(candles[:i], side, config)
        if not trending or level is None or not _crosses(candles[i - 1], candles[i], level, side):
            continue
        ob = _ob_before(candles, i, side, config.ob_lookback)
        if ob is None:
            continue
        for j in range(i + 1, len(candles)):
            candle = candles[j]
            if _invalidates(candle, ob, side):
                break
            if _touches(candle, ob):
                expiry = next(
                    (later.close_ms for later in candles[j + 1:] if _invalidates(later, ob, side)),
                    float("inf"),
                )
                yield ob, candle.close_ms, expiry
                break


def detect(
    symbol: str,
    pair: str,
    htf: Sequence[Candle],
    ltf: Sequence[Candle],
    config: StrategyConfig = StrategyConfig(),
) -> list[Candidate]:
    """Emit at LTF OB formation, after CHOCH closes; no LTF OB retest needed."""
    if pair not in PAIRS:
        raise ValueError("Unsupported timeframe pair")
    if any(a.open_ms >= b.open_ms for a, b in zip(htf, htf[1:])):
        raise ValueError("HTF candles must be sorted and unique")
    if any(a.open_ms >= b.open_ms for a, b in zip(ltf, ltf[1:])):
        raise ValueError("LTF candles must be sorted and unique")
    found: dict[str, Candidate] = {}
    for side in ("SHORT", "LONG"):
        for htf_ob, htf_retest_ms, expiry in _htf_retests(htf, side, config):
            eligible = [c for c in ltf if c.open_ms >= htf_retest_ms and c.close_ms < expiry]
            opposite: Side = "LONG" if side == "SHORT" else "SHORT"
            for i in range(2 * config.swing_span + 4, len(eligible)):
                trending, _ = _trend(eligible[:i], opposite, config)
                highs, lows = _pivots(eligible[:i], config.swing_span)
                pivot_indexes = lows if side == "SHORT" else highs
                level = (eligible[pivot_indexes[-1]].low if side == "SHORT" else eligible[pivot_indexes[-1]].high) if pivot_indexes else None
                if not trending or level is None or not _crosses(eligible[i - 1], eligible[i], level, side):
                    continue
                ltf_ob = _ob_before(eligible, i, side, config.ob_lookback)
                if ltf_ob is None:
                    continue
                candidate = Candidate(
                    symbol=symbol, pair=pair, side=side, formed_ms=eligible[i].close_ms,
                    htf_retest_ms=htf_retest_ms, htf_ob=htf_ob,
                    ltf_ob=ltf_ob, choch_level=level,
                )
                found[candidate.key] = candidate
                break  # First CHOCH + OB for this HTF retest.
    return sorted(found.values(), key=lambda value: value.formed_ms)


def latest_trend(htf: Sequence[Candle], config: StrategyConfig = StrategyConfig()) -> str:
    if _trend(htf, "SHORT", config)[0]:
        return "SHORT"
    if _trend(htf, "LONG", config)[0]:
        return "LONG"
    return "WAIT"
