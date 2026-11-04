U=https://gea.esac.esa.int/tap-server/tap/async
B="SELECT COUNT(*) FROM gaiadr3.gaia_source AS g JOIN external.gaiaedr3_distance AS d ON g.source_id=d.source_id WHERE"
run(){ loc=$(curl -sS -o /dev/null -w '%{redirect_url}' $U --data-urlencode REQUEST=doQuery --data-urlencode LANG=ADQL --data-urlencode FORMAT=csv --data-urlencode PHASE=RUN --data-urlencode "QUERY=$2"); echo "$1 job=$loc"
 for i in $(seq 1 150); do ph=$(curl -sS $loc/phase); [ "$ph" = COMPLETED ] && { curl -sSL $loc/results/result > $1.async.out; echo "$1 done $(tr '\n' ' ' <$1.async.out)"; return; }; [ "$ph" = ERROR ] && { echo "$1 ERROR $(curl -sS $loc/error | head -c 300)"; return; }; sleep 20; done; echo "$1 still $ph"; }
for p in 5 10; do for m in 17 19; do run "p${p}_g${m}" "$B g.parallax_over_error > $p AND g.phot_g_mean_mag < $m" & done; done; wait
