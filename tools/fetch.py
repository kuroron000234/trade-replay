# Dukascopy datafeed (bi5) から BID の1分足・1時間足を取得し、trade-replay 用バイナリ(gzip)にする
# usage: python3 -I fetch.py <outDir> <PAIR> m1 2025-01 2026-10
#        python3 -I fetch.py <outDir> <PAIR> h1 2015-01 2026-10
import sys, os, lzma, struct, gzip, time, urllib.request, urllib.error, datetime
from concurrent.futures import ThreadPoolExecutor

out_dir, pair, tf, frm, to = sys.argv[1:6]
DIG = {'USDJPY': 3, 'EURJPY': 3, 'GBPJPY': 3, 'EURUSD': 5, 'GBPUSD': 5}[pair]

def get(url):
    for i in range(12):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return b''
            time.sleep(2 + i * 3)
        except Exception:
            time.sleep(2 + i * 3)
    raise RuntimeError('failed ' + url)

def decode(raw, base_ms, step_s):
    if not raw:
        return []
    d = lzma.decompress(raw, format=lzma.FORMAT_ALONE)
    rows = []
    for i in range(len(d) // 24):
        t, o, c, l, h, v = struct.unpack('>iiiiif', d[i * 24:i * 24 + 24])
        if v <= 0 and o == c == l == h:
            continue  # 週末などのフラット足
        rows.append((base_ms // 60000 + t // 60, o, h, l, c, v))
    return rows

def varint(out, v):
    while v > 127:
        out.append((v & 127) | 128); v >>= 7
    out.append(v)

zz = lambda v: -2 * v - 1 if v < 0 else 2 * v

def encode(rows, step):
    out = bytearray()
    base = rows[0][0]
    prev_t, prev_c = base, 0
    for tm, o, h, l, c, v in rows:
        h = max(h, o, c); l = min(l, o, c)
        varint(out, (tm - prev_t) // step)
        varint(out, zz(o - prev_c)); varint(out, zz(c - o))
        varint(out, h - max(o, c)); varint(out, min(o, c) - l)
        varint(out, max(0, round(v)))
        prev_t, prev_c = tm, c
    head = struct.pack('<IIII', 0x31585246, len(rows), base, DIG)
    return gzip.compress(head + bytes(out), 9)

def months(a, b):
    y, m = map(int, a.split('-')); y2, m2 = map(int, b.split('-'))
    while (y, m) <= (y2, m2):
        yield y, m
        m += 1
        if m > 12: m, y = 1, y + 1

d = f'{out_dir}/{pair}'
os.makedirs(d, exist_ok=True)
pool = ThreadPoolExecutor(3)

if tf == 'h1':
    def month_rows(ym):
        y, m = ym
        base = int(datetime.datetime(y, m, 1, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        return decode(get(f'https://datafeed.dukascopy.com/datafeed/{pair}/{y}/{m-1:02d}/BID_candles_hour_1.bi5'), base, 3600)
    rows = [r for part in pool.map(month_rows, list(months(frm, to))) for r in part]
    open(f'{d}/h1.bin.gz', 'wb').write(encode(rows, 60))
    print(pair, 'h1', len(rows), flush=True)
else:
    for y, m in months(frm, to):
        name = f'{d}/m1-{y}-{m:02d}.bin.gz'
        if os.path.exists(name):
            continue
        n = (datetime.date(y + (m == 12), m % 12 + 1, 1) - datetime.date(y, m, 1)).days
        def day_rows(day):
            base = int(datetime.datetime(y, m, day, tzinfo=datetime.timezone.utc).timestamp() * 1000)
            return decode(get(f'https://datafeed.dukascopy.com/datafeed/{pair}/{y}/{m-1:02d}/{day:02d}/BID_candles_min_1.bi5'), base, 60)
        rows = [r for part in pool.map(day_rows, range(1, n + 1)) for r in part]
        if rows:
            open(name, 'wb').write(encode(rows, 1))
        print(pair, y, m, len(rows), flush=True)
