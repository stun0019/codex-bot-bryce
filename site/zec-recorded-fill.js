// ZEC candidate reconstructed from the Binance candles used for the original scan.
window.ZecRecordedFill = {
  "symbol": "ZECUSDT",
  "strategyVersion": "macd-ob-fib-0715-v1",
  "strategyName": "4H MACD＋15M BOS／OB／Fib",
  "profileId": "4h15m",
  "timeframeLabel": "4H＋15M",
  "direction": "SHORT",
  "setupId": "bos-1794174300000-1794174300000-fib-limit-wave-stop",
  "confirmedAt": 1794182400000,
  "expiresAt": 9007199254740991,
  "entryType": "LIMIT",
  "targetMode": "FIB",
  "partialExit": true,
  "targetCount": 4,
  "exitFractions": [
    0.3,
    0.2,
    0.2,
    0.3
  ],
  "riskFraction": 0.05,
  "capital": 100,
  "tickSize": 0.01,
  "market": {
    "symbol": "ZECUSDT",
    "contractType": "PERPETUAL",
    "underlyingType": "COIN",
    "tickSize": 0.01,
    "stepSize": 0.001
  },
  "macdDivergence": {
    "timeframe": "4H",
    "bottom": {
      "state": "NONE",
      "points": [
        {
          "price": 1212.4,
          "dif": 16.18325512854676,
          "openTime": 1793880000000,
          "confirmedAt": 1793923200000
        },
        {
          "price": 1235.21,
          "dif": 7.4391073897038495,
          "openTime": 1794081600000,
          "confirmedAt": 1794124800000
        }
      ]
    },
    "top": {
      "state": "NONE",
      "points": [
        {
          "price": 1387.98,
          "dif": 17.714767460931853,
          "openTime": 1793966400000,
          "confirmedAt": 1794009600000
        },
        {
          "price": 1293,
          "dif": 2.793958812144183,
          "openTime": 1794124800000,
          "confirmedAt": 1794168000000
        }
      ]
    },
    "state": "NONE",
    "at": 1794182400000
  },
  "fibSetup": {
    "direction": "SHORT",
    "anchorMode": "WAVE_FIB_LIMIT",
    "stopMode": "WAVE_ORIGIN",
    "ob": {
      "openTime": 1794168900000,
      "closeTime": 1794169799999,
      "open": 1257.96,
      "high": 1259.27,
      "low": 1254.23,
      "close": 1258.25,
      "volume": 4642.015
    },
    "bos": {
      "openTime": 1794174300000,
      "closeTime": 1794175199999,
      "open": 1212.67,
      "high": 1218.49,
      "low": 1176.98,
      "close": 1208.47,
      "volume": 74061.301
    },
    "previous": {
      "openTime": 1794173400000,
      "closeTime": 1794174299999,
      "open": 1226.46,
      "high": 1229.98,
      "low": 1208.46,
      "close": 1212.67,
      "volume": 36439.788
    },
    "broken": {
      "side": "LOW",
      "price": 1212.4,
      "openTime": 1793893500000,
      "confirmedAt": 1793896200000,
      "bars": [
        {
          "openTime": 1793891700000,
          "closeTime": 1793892599999,
          "open": 1233.68,
          "high": 1263.96,
          "low": 1225.81,
          "close": 1238.75,
          "volume": 105338.419
        },
        {
          "openTime": 1793892600000,
          "closeTime": 1793893499999,
          "open": 1238.85,
          "high": 1255.56,
          "low": 1234.18,
          "close": 1246.24,
          "volume": 50968.072
        },
        {
          "openTime": 1793893500000,
          "closeTime": 1793894399999,
          "open": 1246.24,
          "high": 1247.33,
          "low": 1212.4,
          "close": 1237.63,
          "volume": 88073.469
        },
        {
          "openTime": 1793894400000,
          "closeTime": 1793895299999,
          "open": 1237.63,
          "high": 1269.95,
          "low": 1230.52,
          "close": 1265.66,
          "volume": 80500.296
        },
        {
          "openTime": 1793895300000,
          "closeTime": 1793896199999,
          "open": 1265.82,
          "high": 1289.54,
          "low": 1265.15,
          "close": 1282.48,
          "volume": 86018.72
        }
      ]
    },
    "bosTrend": {
      "dif": 0.13493067153808624,
      "signal": 6.162527365129965,
      "histogram": -6.027596693591879,
      "direction": "LONG",
      "at": 1794168000000
    },
    "readyTrend": {
      "dif": -4.921795880906529,
      "signal": 3.9456627159226665,
      "histogram": -8.867458596829195,
      "direction": "SHORT",
      "at": 1794182400000
    },
    "endpoint": {
      "side": "LOW",
      "price": 1176.98,
      "openTime": 1794174300000,
      "confirmedAt": 1794177000000,
      "bars": [
        {
          "openTime": 1794172500000,
          "closeTime": 1794173399999,
          "open": 1238.08,
          "high": 1241.51,
          "low": 1224.04,
          "close": 1226.47,
          "volume": 32031.773
        },
        {
          "openTime": 1794173400000,
          "closeTime": 1794174299999,
          "open": 1226.46,
          "high": 1229.98,
          "low": 1208.46,
          "close": 1212.67,
          "volume": 36439.788
        },
        {
          "openTime": 1794174300000,
          "closeTime": 1794175199999,
          "open": 1212.67,
          "high": 1218.49,
          "low": 1176.98,
          "close": 1208.47,
          "volume": 74061.301
        },
        {
          "openTime": 1794175200000,
          "closeTime": 1794176099999,
          "open": 1208.51,
          "high": 1223.94,
          "low": 1203.14,
          "close": 1219.52,
          "volume": 47473.599
        },
        {
          "openTime": 1794176100000,
          "closeTime": 1794176999999,
          "open": 1219.52,
          "high": 1221.54,
          "low": 1210,
          "close": 1213.31,
          "volume": 14747.347
        }
      ]
    },
    "stopStructure": {
      "side": "HIGH",
      "price": 1268.74,
      "openTime": 1794166200000,
      "confirmedAt": 1794168900000,
      "bars": [
        {
          "openTime": 1794164400000,
          "closeTime": 1794165299999,
          "open": 1265.89,
          "high": 1265.97,
          "low": 1261,
          "close": 1262.71,
          "volume": 6062.274
        },
        {
          "openTime": 1794165300000,
          "closeTime": 1794166199999,
          "open": 1262.71,
          "high": 1265,
          "low": 1260.08,
          "close": 1263.58,
          "volume": 4367.643
        },
        {
          "openTime": 1794166200000,
          "closeTime": 1794167099999,
          "open": 1263.58,
          "high": 1268.74,
          "low": 1262.59,
          "close": 1264.5,
          "volume": 4921.195
        },
        {
          "openTime": 1794167100000,
          "closeTime": 1794167999999,
          "open": 1264.52,
          "high": 1265.33,
          "low": 1257.84,
          "close": 1259.73,
          "volume": 3490.254
        },
        {
          "openTime": 1794168000000,
          "closeTime": 1794168899999,
          "open": 1259.73,
          "high": 1260.43,
          "low": 1252.86,
          "close": 1257.95,
          "volume": 7308.983
        }
      ]
    },
    "leg": [
      {
        "openTime": 1794168900000,
        "closeTime": 1794169799999,
        "open": 1257.96,
        "high": 1259.27,
        "low": 1254.23,
        "close": 1258.25,
        "volume": 4642.015
      },
      {
        "openTime": 1794169800000,
        "closeTime": 1794170699999,
        "open": 1258.25,
        "high": 1259.68,
        "low": 1247.06,
        "close": 1252.42,
        "volume": 7519.039
      },
      {
        "openTime": 1794170700000,
        "closeTime": 1794171599999,
        "open": 1252.42,
        "high": 1252.42,
        "low": 1239.95,
        "close": 1242.73,
        "volume": 15162.847
      },
      {
        "openTime": 1794171600000,
        "closeTime": 1794172499999,
        "open": 1242.72,
        "high": 1247.81,
        "low": 1236.92,
        "close": 1238.09,
        "volume": 21338.677
      },
      {
        "openTime": 1794172500000,
        "closeTime": 1794173399999,
        "open": 1238.08,
        "high": 1241.51,
        "low": 1224.04,
        "close": 1226.47,
        "volume": 32031.773
      },
      {
        "openTime": 1794173400000,
        "closeTime": 1794174299999,
        "open": 1226.46,
        "high": 1229.98,
        "low": 1208.46,
        "close": 1212.67,
        "volume": 36439.788
      },
      {
        "openTime": 1794174300000,
        "closeTime": 1794175199999,
        "open": 1212.67,
        "high": 1218.49,
        "low": 1176.98,
        "close": 1208.47,
        "volume": 74061.301
      }
    ],
    "afterBos": [
      {
        "openTime": 1794175200000,
        "closeTime": 1794176099999,
        "open": 1208.51,
        "high": 1223.94,
        "low": 1203.14,
        "close": 1219.52,
        "volume": 47473.599
      },
      {
        "openTime": 1794176100000,
        "closeTime": 1794176999999,
        "open": 1219.52,
        "high": 1221.54,
        "low": 1210,
        "close": 1213.31,
        "volume": 14747.347
      }
    ],
    "tickSize": 0.01,
    "fibOrigin": {
      "side": "HIGH",
      "price": 1269.49,
      "openTime": 1794162600000,
      "confirmedAt": 1794165300000,
      "bars": [
        {
          "openTime": 1794160800000,
          "closeTime": 1794161699999,
          "open": 1250.56,
          "high": 1257.36,
          "low": 1248.05,
          "close": 1254.3,
          "volume": 9736.552
        },
        {
          "openTime": 1794161700000,
          "closeTime": 1794162599999,
          "open": 1254.3,
          "high": 1266.3,
          "low": 1253.97,
          "close": 1260.31,
          "volume": 21011.773
        },
        {
          "openTime": 1794162600000,
          "closeTime": 1794163499999,
          "open": 1260.32,
          "high": 1269.49,
          "low": 1260.07,
          "close": 1265.04,
          "volume": 6881.824
        },
        {
          "openTime": 1794163500000,
          "closeTime": 1794164399999,
          "open": 1265.07,
          "high": 1267.71,
          "low": 1263.95,
          "close": 1265.9,
          "volume": 3686.199
        },
        {
          "openTime": 1794164400000,
          "closeTime": 1794165299999,
          "open": 1265.89,
          "high": 1265.97,
          "low": 1261,
          "close": 1262.71,
          "volume": 6062.274
        }
      ]
    }
  },
  "entry": 1243.12,
  "stopLoss": 1269.5,
  "target": 1176.98,
  "targets": [
    1176.98,
    1152.01,
    1119.81,
    1084.47
  ],
  "entryLocation": "FIB_0715",
  "fibEntry": 1243.12465
};
