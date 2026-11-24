#!/bin/bash
O=$HOME/trade-replay/data/fx
cd "$(dirname "$0")"  # tools/ から実行
for p in USDJPY EURUSD; do python3 -I fetch.py $O $p m1 2026-07 2026-10; done
for p in USDJPY EURUSD GBPJPY EURJPY GBPUSD; do [ -f $O/$p/h1.bin.gz ] || python3 -I fetch.py $O $p h1 2018-01 2026-10; done
for p in GBPJPY EURJPY GBPUSD; do python3 -I fetch.py $O $p m1 2026-07 2026-10; done
for p in USDJPY EURUSD GBPJPY EURJPY GBPUSD; do python3 -I fetch.py $O $p m1 2026-01 2026-06; done
for p in USDJPY EURUSD GBPJPY EURJPY GBPUSD; do python3 -I fetch.py $O $p m1 2025-01 2025-12; done
echo ALLDONE
