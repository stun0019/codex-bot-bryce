"""SQLite-backed observation scanner. No exchange account or order access."""
from __future__ import annotations

import sqlite3
from contextlib import closing
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Callable

from .bingx import fetch_closed_candles
from .strategy import Candle, PAIRS, StrategyConfig, detect

SYMBOLS = ("ZEC-USDT", "ENA-USDT")
DATABASE = Path(__file__).resolve().parents[1] / "data" / "observer.sqlite3"


class Observer:
    def __init__(
        self,
        database: Path = DATABASE,
        fetcher: Callable[[str, str], list[Candle]] = fetch_closed_candles,
        config: StrategyConfig = StrategyConfig(),
    ) -> None:
        self.database = database
        self.fetcher = fetcher
        self.config = config
        self.lock = Lock()
        self.last_scan: str | None = None
        self.last_error: str | None = None
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                "CREATE TABLE IF NOT EXISTS candidates "
                "(key TEXT PRIMARY KEY, formed_ms INTEGER NOT NULL, payload TEXT NOT NULL)"
            )

    def _connect(self) -> sqlite3.Connection:
        return sqlite3.connect(self.database, timeout=5)

    def scan_once(self) -> int:
        import json

        intervals = sorted({interval for pair in PAIRS.values() for interval in pair})
        data: dict[tuple[str, str], list[Candle]] = {}
        errors: list[str] = []
        with ThreadPoolExecutor(max_workers=4) as pool:
            jobs = {
                pool.submit(self.fetcher, symbol, interval): (symbol, interval)
                for symbol in SYMBOLS for interval in intervals
            }
            for job in as_completed(jobs):
                key = jobs[job]
                try:
                    data[key] = job.result()
                except Exception as exc:
                    errors.append(f"{key[0]} {key[1]}: {exc}")

        new_count = 0
        with self.lock, closing(self._connect()) as connection, connection:
            for symbol in SYMBOLS:
                for pair, (higher, lower) in PAIRS.items():
                    htf, ltf = data.get((symbol, higher)), data.get((symbol, lower))
                    if not htf or not ltf:
                        continue
                    try:
                        # Only the latest completed lower-timeframe candle may create a new observation.
                        latest_closed = ltf[-1].close_ms
                        for candidate in detect(symbol, pair, htf, ltf, self.config):
                            if candidate.formed_ms != latest_closed:
                                continue
                            cursor = connection.execute(
                                "INSERT OR IGNORE INTO candidates(key, formed_ms, payload) VALUES (?, ?, ?)",
                                (candidate.key, candidate.formed_ms, json.dumps(candidate.as_dict())),
                            )
                            new_count += cursor.rowcount
                    except Exception as exc:
                        errors.append(f"{symbol} {pair}: {exc}")
            self.last_scan = datetime.now(timezone.utc).isoformat()
            self.last_error = "; ".join(errors) if errors else None
        return new_count

    def status(self) -> dict:
        with self.lock:
            return {
                "last_scan_utc": self.last_scan,
                "error": self.last_error,
                "symbols": list(SYMBOLS),
                "pairs": list(PAIRS),
                "mode": "OBSERVATION_ONLY",
            }

    def candidates(self, limit: int = 30) -> list[dict]:
        import json

        with self.lock, closing(self._connect()) as connection, connection:
            rows = connection.execute(
                "SELECT payload FROM candidates ORDER BY formed_ms DESC LIMIT ?", (limit,)
            ).fetchall()
        return [json.loads(row[0]) for row in rows]
