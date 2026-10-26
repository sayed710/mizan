import os, re, sys, itertools
root = sys.argv[1]
files = []
for d in ('src', 'server'):
    for dp, _, fs in os.walk(os.path.join(root, d)):
        for f in fs:
            if (f.endswith('.js') or f.endswith('.jsx')) and not f.endswith('.test.js'):
                files.append(os.path.relpath(os.path.join(dp, f), root))
rx = re.compile(r"""^\s*(?:import|export)\s[^;]*?from\s+['"](\.[^'"]+)['"]""", re.M | re.S)
dyn = re.compile(r"""import\(\s*['"](\.[^'"]+)['"]\s*\)""")
G = {f: set() for f in files}
for f in files:
    src = open(os.path.join(root, f), encoding='utf8').read()
    for m in list(rx.finditer(src)) + list(dyn.finditer(src)):
        t = os.path.normpath(os.path.join(os.path.dirname(f), m.group(1)))
        if t in G: G[f].add(t)
edges = sum(len(v) for v in G.values())
print('modules', len(G), 'edges', edges)
# Tarjan SCC
sys.setrecursionlimit(10000)
idx = {}; low = {}; st = []; on = set(); sccs = []; c = [0]
def sc(v):
    idx[v] = low[v] = c[0]; c[0] += 1; st.append(v); on.add(v)
    for w in G[v]:
        if w not in idx: sc(w); low[v] = min(low[v], low[w])
        elif w in on: low[v] = min(low[v], idx[w])
    if low[v] == idx[v]:
        comp = []
        while True:
            w = st.pop(); on.discard(w); comp.append(w)
            if w == v: break
        sccs.append(comp)
for v in G:
    if v not in idx: sc(v)
big = [s for s in sccs if len(s) > 1]
print('non-trivial SCCs:', len(big), 'sizes:', sorted(len(s) for s in big))
for s in big:
    print('  SCC members (%d); non-models: %s; models in SCC: %d' % (len(s), sorted(x for x in s if not x.startswith('src/models/')), sum(1 for x in s if x.startswith('src/models/'))))
    print('  model files NOT in SCC:', sorted(x for x in G if x.startswith('src/models/') and x not in s))
# count 2-cycles
two = sorted({tuple(sorted((a, b))) for a in G for b in G[a] if a in G[b]})
print('mutual (2-node) import pairs:', len(two))
for a, b in two: print('   ', a, '<->', b)
# count simple cycles with Johnson-like bounded DFS within SCCs (cap)
def count_cycles(nodes, cap=2000000):
    nodes = sorted(nodes); pos = {n: i for i, n in enumerate(nodes)}; total = 0
    for s in nodes:
        sub = {n for n in nodes if pos[n] >= pos[s]}
        stack = [(s, iter(sorted(G[s] & sub)))]; path = [s]; onp = {s}
        while stack:
            v, it = stack[-1]
            nxt = next(it, None)
            if nxt is None:
                stack.pop(); onp.discard(path.pop()); continue
            if nxt == s: total += 1
            elif nxt not in onp:
                path.append(nxt); onp.add(nxt); stack.append((nxt, iter(sorted(G[nxt] & sub))))
            if total >= cap: return total, True
    return total, False
for s in big:
    n, capped = count_cycles(s)
    print('elementary cycles in SCC of size %d: %s%d' % (len(s), '>=' if capped else '', n))
# fan-in / fan-out
fin = {f: 0 for f in G}
for a in G:
    for b in G[a]: fin[b] += 1
print('top fan-in:', sorted(((v, k) for k, v in fin.items()), reverse=True)[:8])
print('top fan-out:', sorted(((len(v), k) for k, v in G.items()), reverse=True)[:6])
# models importing server or views importing models etc
print('src/models -> src/views imports:', sum(1 for a in G for b in G[a] if a.startswith('src/models') and b.startswith('src/views')))
print('server -> src imports:', sum(1 for a in G for b in G[a] if a.startswith('server') and b.startswith('src')))
print('src -> server imports:', sum(1 for a in G for b in G[a] if a.startswith('src') and b.startswith('server')))
