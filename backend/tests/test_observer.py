import tempfile
import unittest
from pathlib import Path

from codex_bot.bingx import MarketDataError, parse_closed_candles
from codex_bot.scanner import Observer
from codex_bot.strategy import Candle, StrategyConfig, detect

CONFIG = StrategyConfig(swing_span=1, ob_lookback=4)
HTF = [
    (98, 102, 96, 99), (100, 110, 98, 105), (103, 105, 95, 97),
    (100, 108, 99, 104), (96, 103, 90, 92), (97, 106, 94, 102),
    (93, 101, 85, 87), (94, 104, 91, 100), (87, 99, 83, 84),
    (85, 100, 82, 93),
]
LTF = [
    (93, 96, 90, 94), (95, 100, 94, 98), (97, 98, 92, 94),
    (96, 103, 95, 100), (98, 101, 94, 96), (98, 105, 96, 102),
    (98, 102, 95, 97), (98, 104, 97, 100), (96, 103, 90, 93),
]


def candles(rows, start, duration, reflect=False):
    if reflect:
        rows = [(200 - op, 200 - low, 200 - high, 200 - close) for op, high, low, close in rows]
    return [
        Candle(start + i * duration, start + (i + 1) * duration, *row, volume=1)
        for i, row in enumerate(rows)
    ]


class StrategyTests(unittest.TestCase):
    def test_short_ob_forms_after_choch_without_low_timeframe_retest(self):
        htf = candles(HTF, 0, 100)
        ltf = candles(LTF, 1000, 10)
        self.assertEqual(detect("ZEC-USDT", "H4/M15", htf, ltf[:-1], CONFIG), [])
        found = detect("ZEC-USDT", "H4/M15", htf, ltf, CONFIG)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0].side, "SHORT")
        self.assertEqual(found[0].formed_ms, ltf[-1].close_ms)

    def test_long_mirror_and_pair_label(self):
        found = detect("ENA-USDT", "H1/M5",
                       candles(HTF, 0, 100, True), candles(LTF, 1000, 10, True), CONFIG)
        self.assertEqual(len(found), 1)
        self.assertEqual((found[0].side, found[0].pair), ("LONG", "H1/M5"))

    def test_only_supported_pairs(self):
        with self.assertRaises(ValueError):
            detect("ZEC-USDT", "H4/M5", [], [], CONFIG)


class MarketDataTests(unittest.TestCase):
    def test_closed_candles_only_and_utc_milliseconds(self):
        rows = [
            [0, "10", "12", "9", "11", "3", 299999],
            [300000, "11", "13", "10", "12", "4", 599999],
        ]
        result = parse_closed_candles(rows, "5m", 300000)
        self.assertEqual(len(result), 1)
        self.assertEqual((result[0].open_ms, result[0].close_ms), (0, 300000))

    def test_malformed_row(self):
        with self.assertRaises(MarketDataError):
            parse_closed_candles([["bad"]], "5m", 300000)


class ScannerTests(unittest.TestCase):
    def test_latest_only_and_deduplication(self):
        htf = candles(HTF, 0, 100)
        ltf = candles(LTF, 1000, 10)
        def fetcher(symbol, interval):
            if symbol != "ZEC-USDT":
                raise MarketDataError("offline")
            return htf if interval in ("4h", "1h") else ltf
        with tempfile.TemporaryDirectory() as temp:
            observer = Observer(Path(temp) / "test.sqlite3", fetcher, CONFIG)
            self.assertEqual(observer.scan_once(), 2)
            self.assertEqual(observer.scan_once(), 0)
            self.assertEqual(len(observer.candidates()), 2)
            self.assertIn("ENA-USDT", observer.status()["error"])


if __name__ == "__main__":
    unittest.main()
