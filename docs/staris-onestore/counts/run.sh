q(){ curl -sS --max-time 900 -o "$1.out" -w "$1 http=%{http_code} t=%{time_total}\n" https://gea.esac.esa.int/tap-server/tap/sync --data-urlencode REQUEST=doQuery --data-urlencode LANG=ADQL --data-urlencode FORMAT=csv --data-urlencode "QUERY=$2" 2>&1; }
B="SELECT COUNT(*) FROM gaiadr3.gaia_source AS g JOIN external.gaiaedr3_distance AS d ON g.source_id=d.source_id WHERE"
for p in 5 10; do for m in 15 17 19; do q "p${p}_g${m}" "$B g.parallax_over_error > $p AND g.phot_g_mean_mag < $m" & done; done; wait
