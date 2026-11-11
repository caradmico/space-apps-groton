import sys, os, json, hashlib
sys.path.insert(0, '/workspace/staris-hats/tools/staris-pipeline')
import pyramid, numpy as np
a, b = sys.argv[1], sys.argv[2]
pa_, pb_ = os.path.join(a, 'pyramid/packs'), os.path.join(b, 'pyramid/packs')
fa = sorted(f for f in os.listdir(pa_) if f.endswith('.pack')); fb = sorted(f for f in os.listdir(pb_) if f.endswith('.pack'))
print('packs', len(fa), len(fb), 'same names', fa == fb)
cells = mism = byte_ident = 0
for f in fa:
    A = pyramid.read_pack(os.path.join(pa_, f)); B = pyramid.read_pack(os.path.join(pb_, f))
    byte_ident += open(os.path.join(pa_, f),'rb').read() == open(os.path.join(pb_, f),'rb').read()
    ta = {l: (s, c) for l, s, c in A['cells']}; tb = {l: (s, c) for l, s, c in B['cells']}
    for l in set(ta) | set(tb):
        cells += 1
        if l not in ta or l not in tb: mism += 1; continue
        ra = A['payload'][ta[l][0]*10:(ta[l][0]+ta[l][1])*10]; rb = B['payload'][tb[l][0]*10:(tb[l][0]+tb[l][1])*10]
        if not np.array_equal(ra, rb): mism += 1
ja = json.load(open(os.path.join(pa_, 'tiles.json'))); jb = json.load(open(os.path.join(pb_, 'tiles.json')))
print('cells_compared', cells, 'mismatching_cells', mism, 'byte_identical_pack_files', byte_ident, '/', len(fa))
print('tiles.json equal', ja == jb, 'total_records', ja['total_records'], jb['total_records'])
