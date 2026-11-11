#!/bin/bash
S=/workspace/staris-hats-fix-scratch; O=$S/$1
rm -rf $O; mkdir -p $O
cd /workspace/staris-hats/tools/staris-pipeline
t0=$(date +%s.%N)
/workspace/staris-hats-venv/bin/python staris_run.py --source hats --partitions 2/0,2/1 --coarse --out $O --prefix test-2p/ > $S/run-$1.txt 2>&1 &
P=$!; max=0; rss=0
while kill -0 $P 2>/dev/null; do s=$(du -sb $O 2>/dev/null | cut -f1); [ "${s:-0}" -gt $max ] && max=$s; r=$(awk '/VmHWM/{print $2}' /proc/$P/status 2>/dev/null); [ -n "$r" ] && rss=$r; sleep 0.1; done
wait $P; rc=$?; t1=$(date +%s.%N)
echo "exit=$rc PEAK_BYTES=$max PEAK_RSS_KB=$rss ELAPSED_S=$(echo "$t1 - $t0" | bc)"
grep -v "write Gaia" $S/run-$1.txt; du -sb $O $O/* $O/hats_stream/*
