#!/bin/bash
S=/workspace/staris-hats-fix-scratch; O=$S/big112
rm -rf $O; mkdir -p $O
cd /workspace/staris-hats/tools/staris-pipeline
/workspace/staris-hats-venv/bin/python staris_run.py --source hats --partitions $(cat $S/big112.parts) --deep --out $O --prefix test-big112/ --max-rss-gb 3 > $S/run-big112.txt 2>&1 &
P=$!; echo "pid $P"
: > $S/big112.rss
while kill -0 $P 2>/dev/null; do r=$(awk '/VmRSS/{a=$2} /VmHWM/{b=$2} END{print a, b}' /proc/$P/status 2>/dev/null); d=$(du -sb $O 2>/dev/null | cut -f1); echo "$(date +%s) $r $d" >> $S/big112.rss; sleep 0.5; done
wait $P; echo "exit=$?" >> $S/big112.rss
