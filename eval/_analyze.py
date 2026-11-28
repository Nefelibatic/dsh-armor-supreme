import json, io, sys
from collections import Counter

data = json.load(io.open('eval/grades.json', encoding='utf-8'))
rs = data['items']
fails = [r for r in rs if not r.get('passed')]
passes = [r for r in rs if r.get('passed')]
print('总', len(rs), 'PASS', len(passes), 'FAIL', len(fails))

key = 'veto' if fails and 'veto' in fails[0] else None
print('字段:', list(rs[0].keys()))
print()

veto_count = Counter()
soft_count = Counter()
for r in fails:
    for v in (r.get('veto') or []):
        veto_count[str(v)] += 1
    for s in (r.get('soft') or []):
        soft_count[str(s)[:40]] += 1

print('=== veto 命中 TOP ===')
for k, n in veto_count.most_common(20):
    print(f'{n:4d}  {k}')
print()
print('=== soft 命中 TOP ===')
for k, n in soft_count.most_common(20):
    print(f'{n:4d}  {k}')
print()
print('=== FAIL 按域 ===')
d = Counter(r['domain'] for r in fails)
for k, n in d.most_common():
    print(f'{n:4d}  {k}')
print()
print('=== 低分 FAIL 前 25 ===')
fails.sort(key=lambda r: r.get('score', 0))
for r in fails[:25]:
    print(f"{r['id']:<14} {r['domain']:<12} score={r.get('score'):>3} veto={(r.get('veto') or [])[:2]} soft={len(r.get('soft') or [])} len={r['detail']['len'] if isinstance(r.get('detail'),dict) else '?' or '?'}")


