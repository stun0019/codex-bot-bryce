"""BingX public USDT perpetual candles. No credentials or private endpoints."""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .strategy import Candle

ENDPOINT = "https://open-api.bingx.com/openApi/swap/v3/quote/klines"
INTERVAL_MS = {"4h": 14_400_000, "15m": 900_000, "1h": 3_600_000, "5m": 300_000}


class MarketDataError(RuntimeError):
    pass


def parse_closed_candles(data: object, interval: str, now_ms: int) -> list[Candle]:
    if interval not in INTERVAL_MS or not isinstance(data, list):
        raise MarketDataError("Invalid candle response")
    candles: dict[int, Candle] = {}
    for row in data:
        try:
            if not isinstance(row, list) or len(row) < 6:
                raise ValueError("Invalid row")
            start = int(row[0])
            # BingX closeTime is inclusive; use an exclusive close timestamp internally.
            end = int(row[6]) + 1 if len(row) > 6 and row[6] is not None else start + INTERVAL_MS[interval]
            if end <= start or end > now_ms:
                continue
            candle = Candle(
                open_ms=start, close_ms=end,
                open=float(row[1]), high=float(row[2]), low=float(row[3]),
                close=float(row[4]), volume=float(row[5]),
            )
            candles[start] = candle
        except (TypeError, ValueError, OverflowError) as exc:
            raise MarketDataError("Malformed BingX candle") from exc
    return sorted(candles.values(), key=lambda item: item.open_ms)


def fetch_closed_candles(symbol: str, interval: str, limit: int = 300) -> list[Candle]:
    if interval not in INTERVAL_MS or not symbol.endswith("-USDT") or not 1 <= limit <= 500:
        raise ValueError("Unsupported symbol, interval, or limit")
    url = ENDPOINT + "?" + urlencode({"symbol": symbol, "interval": interval, "limit": limit})
    last_error: Exception | None = None
    for attempt in range(2):
        try:
            request = Request(url, headers={"Accept": "application/json", "User-Agent": "codex-bot-observer/0.1"})
            with urlopen(request, timeout=8) as response:
                payload = json.load(response)
            if not isinstance(payload, dict) or str(payload.get("code")) != "0":
                raise MarketDataError(f"BingX API error: {payload.get('code') if isinstance(payload, dict) else 'invalid'}")
            candles = parse_closed_candles(payload.get("data"), interval, int(datetime.now(timezone.utc).timestamp() * 1000))
            if not candles:
                raise MarketDataError("No closed candles returned")
            return candles
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError, MarketDataError) as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(1)
    raise MarketDataError(f"BingX {symbol} {interval}: {last_error}") from last_error
