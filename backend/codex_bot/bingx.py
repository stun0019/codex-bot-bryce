"""BingX public USDT perpetual contracts and closed candles; no credentials."""
from __future__ import annotations

import json
import re
import time
from datetime import datetime, timezone
from threading import Lock
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .strategy import Candle

BASE_URL = "https://open-api.bingx.com"
KLINES_PATH = "/openApi/swap/v3/quote/klines"
CONTRACTS_PATH = "/openApi/swap/v2/quote/contracts"
INTERVAL_MS = {"4h": 14_400_000, "15m": 900_000, "1h": 3_600_000, "5m": 300_000}
REQUEST_GAP_SECONDS = 1.1  # Conservative shared IP pacing.
_request_lock = Lock()
_next_request_at = 0.0


class MarketDataError(RuntimeError):
    pass


def _pace_request() -> None:
    global _next_request_at
    with _request_lock:
        wait = _next_request_at - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _next_request_at = time.monotonic() + REQUEST_GAP_SECONDS


def _public_get(path: str, params: dict | None = None) -> object:
    url = BASE_URL + path + ("?" + urlencode(params) if params else "")
    last_error: Exception | None = None
    for attempt in range(2):
        _pace_request()
        try:
            request = Request(url, headers={"Accept": "application/json", "User-Agent": "codex-bot-observer/0.2"})
            with urlopen(request, timeout=8) as response:
                payload = json.load(response)
            if not isinstance(payload, dict) or str(payload.get("code")) != "0":
                code = payload.get("code") if isinstance(payload, dict) else "invalid"
                raise MarketDataError(f"BingX API error: {code}")
            return payload.get("data")
        except (HTTPError, URLError, TimeoutError, OSError, ValueError, MarketDataError) as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(2)
    raise MarketDataError(f"BingX public API {path}: {last_error}") from last_error


def parse_contract_symbols(data: object) -> tuple[str, ...]:
    """Keep currently tradable USDT-margined perpetual contracts only."""
    if not isinstance(data, list):
        raise MarketDataError("Invalid BingX contracts response")
    symbols: set[str] = set()
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    for contract in data:
        if not isinstance(contract, dict):
            continue
        symbol = str(contract.get("symbol", "")).upper()
        if not re.fullmatch(r"[A-Z0-9]{2,30}-USDT", symbol):
            continue
        if contract.get("currency", "USDT") != "USDT":
            continue
        if str(contract.get("status")) != "1":
            continue
        if str(contract.get("apiStateOpen", "true")).lower() != "true":
            continue
        try:
            off_time = int(contract.get("offTime") or 0)
        except (TypeError, ValueError):
            continue
        if 0 < off_time <= now_ms:
            continue
        symbols.add(symbol)
    if not symbols:
        raise MarketDataError("No active USDT perpetual contracts returned")
    return tuple(sorted(symbols))


def fetch_contract_symbols() -> tuple[str, ...]:
    return parse_contract_symbols(_public_get(CONTRACTS_PATH))


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
    if interval not in INTERVAL_MS or not re.fullmatch(r"[A-Z0-9]{2,30}-USDT", symbol) or not 1 <= limit <= 500:
        raise ValueError("Unsupported symbol, interval, or limit")
    data = _public_get(KLINES_PATH, {"symbol": symbol, "interval": interval, "limit": limit})
    candles = parse_closed_candles(data, interval, int(datetime.now(timezone.utc).timestamp() * 1000))
    if not candles:
        raise MarketDataError(f"No closed candles returned for {symbol} {interval}")
    return candles
