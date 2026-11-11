import sys, os, json, time
sys.path.insert(0, '/workspace/staris-hats/tools/staris-pipeline')
import hats_stream
out = sys.argv[1]
os.makedirs(out, exist_ok=True)
cfg = {"output_dir": os.path.join(out, "pyramid"), "adapter": "hats", "mode": "PILOT", "r2_base": "https://stars.graphicoregon.com",
       "write_deep": False, "deep_source": "hats", "pack_format": "g1b", "rss_cap": 2*1024**3, "region": None}
t = time.time()
hm, pm = hats_stream.run(out, partitions=[(2,0),(2,1)], config=cfg, workers=4, range_workers=8, progress=lambda m: print(time.strftime('%H:%M:%S'), m, flush=True))
print("hm", json.dumps(hm)); print("elapsed", round(time.time()-t,1))
