import sys,os
sys.path.insert(0,'/workspace/staris-hats/tools/staris-pipeline')
import pyramid, numpy as np
a,b=sys.argv[1],sys.argv[2]
for f in sorted(os.listdir(a)):
    if not f.endswith('.pack'): continue
    A=pyramid.read_pack(os.path.join(a,f)); B=pyramid.read_pack(os.path.join(b,f))
    if A['cells']!=B['cells']: print(f,'tables differ', len(A['cells']), len(B['cells'])); 
    ta={l:(s,c) for l,s,c in A['cells']}; tb={l:(s,c) for l,s,c in B['cells']}
    for l in sorted(set(ta)|set(tb)):
        if ta.get(l)!=tb.get(l): print(f,l,ta.get(l),tb.get(l)); continue
        s,c=ta[l]; ra=A['payload'][s*10:(s+c)*10].reshape(-1,10); rb=B['payload'][s*10:(s+c)*10].reshape(-1,10)
        if not np.array_equal(ra,rb): print(f,l,'rows differ', ra.tolist(), rb.tolist(), 'sameset', sorted(map(bytes,ra))==sorted(map(bytes,rb)))
