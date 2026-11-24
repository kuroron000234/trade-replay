# data/fx 以下を走査して index.json を作る（ダウンロードの途中でも実行してよい）
import os, json, re, sys
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data', 'fx')
pairs = {}
for p in sorted(os.listdir(root)):
    d = os.path.join(root, p)
    if not os.path.isdir(d):
        continue
    m1 = sorted(m.group(1) for f in os.listdir(d) if (m := re.match(r'm1-(\d{4}-\d{2})\.bin\.gz$', f)))
    # 途中が抜けた月は使わない（連続した最新の範囲だけ）
    cont = []
    for k in reversed(m1):
        if cont:
            y, mo = map(int, cont[0].split('-'))
            prev = f'{y - (mo == 1)}-{(mo - 2) % 12 + 1:02d}'
            if k != prev:
                break
        cont.insert(0, k)
    pairs[p] = {'m1': cont, 'h1': os.path.exists(os.path.join(d, 'h1.bin.gz'))}
json.dump({'pairs': pairs}, open(os.path.join(root, 'index.json'), 'w'), indent=1)
print(json.dumps(pairs))
