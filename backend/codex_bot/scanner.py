"""Rotating, SQLite-backed observation scanner. No account or order access."""
from __future__ import annotations

import json
import sqlite3
import time
from bisect import bisect_left
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Callable, Sequence

from .bingx import fetch_closed_candles, fetch_contract_symbols
from .strategy import Candle, PAIRS, StrategyConfig, detect

DATABASE = Path(__file__).resolve().parents[1] / "data" / "observer.sqlite3"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


class Observer:
    def __init__(
        self,
        database: Path = DATABASE,
        fetcher: Callable[[str, str], list[Candle]] = fetch_closed_candles,
        config: StrategyConfig = StrategyConfig(),
        symbols_provider: Callable[[], Sequence[str]] = fetch_contract_symbols,
        batch_size: int = 15,
        universe_refresh_seconds: int = 3600,
    ) -> None:
        if batch_size < 1 or universe_refresh_seconds < 1:
            raise ValueError("Scanner settings must be positive")
        self.database = database
        self.fetcher = fetcher
        self.config = config
        self.symbols_provider = symbols_provider
        self.batch_size = batch_size
        self.universe_refresh_seconds = universe_refresh_seconds
        self.lock = Lock()
        self.symbols: tuple[str, ...] = ()
        self.cursor = 0
        self.scanned_in_pass = 0
        self.resume_symbol: str | None = None
        self.next_universe_refresh = 0.0
        self.last_universe_refresh: str | None = None
        self.last_full_pass: str | None = None
        self.last_scan: str | None = None
        self.last_batch_symbols: tuple[str, ...] = ()
        self.last_error: str | None = None
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS candidates "
                "(key TEXT PRIMARY KEY, formed_ms INTEGER NOT NULL, payload TEXT NOT NULL)"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS progress "
                "(symbol TEXT NOT NULL, pair TEXT NOT NULL, close_ms INTEGER NOT NULL, "
                "PRIMARY KEY(symbol, pair))"
            )
            connection.execute(
                "CREATE TABLE IF NOT EXISTS scanner_state "
                "(key TEXT PRIMARY KEY, value TEXT NOT NULL)"
            )
            row = connection.execute(
                "SELECT value FROM scanner_state WHERE key='next_symbol'"
            ).fetchone()
            self.resume_symbol = row[0] if row else None

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database, timeout=5)

    def _refresh_universe(self) -> str | None:
        if self.symbols and time.monotonic() < self.next_universe_refresh:
            return
        previous_next = self.symbols[self.cursor] if self.symbols and self.cursor < len(self.symbols) else self.resume_symbol
        try:
            symbols = tuple(sorted(set(self.symbols_provider())))
            if not symbols:
                raise ValueError("Empty contract universe")
        except Exception as exc:
            if not self.symbols:
                raise RuntimeError(f"Contract discovery failed: {exc}") from exc
            self.next_universe_refresh = time.monotonic() + 60
            return f"Contract refresh failed; using prior list: {exc}"
        self.symbols = symbols
        self.cursor = bisect_left(symbols, previous_next) if previous_next else 0
        if self.cursor >= len(symbols):
            self.cursor = 0
        self.scanned_in_pass = self.cursor
        self.resume_symbol = None
        self.next_universe_refresh = time.monotonic() + self.universe_refresh_seconds
        self.last_universe_refresh = utc_now()
        return None

    def scan_once(self) -> int:
        try:
            refresh_error = self._refresh_universe()
        except Exception as exc:
            with self.lock:
                self.last_scan = utc_now()
                self.last_error = str(exc)
            return 0

        batch = self.symbols[self.cursor:self.cursor + self.batch_size]
        intervals = sorted({interval for higher, lower in PAIRS.values() for interval in (higher, lower)})
        data: dict[tuple[str, str], list[Candle]] = {}
        errors: list[str] = [refresh_error] if refresh_error else []
        with ThreadPoolExecutor(max_workers=4) as pool:
            jobs = {
                pool.submit(self.fetcher, symbol, interval): (symbol, interval)
                for symbol in batch for interval in intervals
            }
            for job in as_completed(jobs):
                key = jobs[job]
                try:
                    data[key] = job.result()
                except Exception as exc:
                    errors.append(f"{key[0]} {key[1]}: {exc}")

        new_count = 0
        with self.lock, closing(self._connect()) as connection, connection:
            for symbol in batch:
                for pair, (higher, lower) in PAIRS.items():
                    htf, ltf = data.get((symbol, higher)), data.get((symbol, lower))
                    if not htf or not ltf:
                        continue
                    try:
                        latest_closed = ltf[-1].close_ms
                        row = connection.execute(
                            "SELECT close_ms FROM progress WHERE symbol=? AND pair=?", (symbol, pair)
                        ).fetchone()
                        prior_close = row[0] if row else None
                        for candidate in detect(symbol, pair, htf, ltf, self.config):
                            # First visit starts with current candle only; later visits catch up.
                            if candidate.formed_ms <= (prior_close if prior_close is not None else latest_closed - 1):
                                continue
                            cursor = connection.execute(
                                "INSERT OR IGNORE INTO candidates(key, formed_ms, payload) VALUES (?, ?, ?)",
                                (candidate.key, candidate.formed_ms, json.dumps(candidate.as_dict())),
                            )
                            new_count += cursor.rowcount
                        connection.execute(
                            "INSERT INTO progress(symbol, pair, close_ms) VALUES (?, ?, ?) "
                            "ON CONFLICT(symbol, pair) DO UPDATE SET close_ms=MAX(close_ms, excluded.close_ms)",
                            (symbol, pair, latest_closed),
                        )
                    except Exception as exc:
                        errors.append(f"{symbol} {pair}: {exc}")
            self.last_scan = utc_now()
            self.last_batch_symbols = batch
            self.cursor += len(batch)
            self.scanned_in_pass += len(batch)
            if self.cursor >= len(self.symbols):
                self.cursor = 0
                self.scanned_in_pass = 0
                self.last_full_pass = self.last_scan
            connection.execute(
                "INSERT INTO scanner_state(key, value) VALUES ('next_symbol', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (self.symbols[self.cursor],),
            )
            self.last_error = "; ".join(errors[:10]) + (f"; plus {len(errors) - 10} more" if len(errors) > 10 else "") if errors else None
        return new_count

    def status(self) -> dict:
        with self.lock:
            return {
                "last_scan_utc": self.last_scan,
                "last_full_pass_utc": self.last_full_pass,
                "universe_refreshed_utc": self.last_universe_refresh,
                "error": self.last_error,
                "symbol_count": len(self.symbols),
                "scanned_in_pass": self.scanned_in_pass,
                "last_batch_symbols": list(self.last_batch_symbols),
                "pairs": list(PAIRS),
                "mode": "OBSERVATION_ONLY",
            }

    def candidates(self, limit: int = 30) -> list[dict]:
        with self.lock, closing(self._connect()) as connection, connection:
            rows = connection.execute(
                "SELECT payload FROM candidates ORDER BY formed_ms DESC LIMIT ?", (limit,)
            ).fetchall()
        return [json.loads(row[0]) for row in rows]
