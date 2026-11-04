#!/bin/bash
# usage: peak.sh DIR PIDFILE -> prints max du bytes
d=$1; max=0; while kill -0 $(cat $2) 2>/dev/null; do s=$(du -sb $d 2>/dev/null | cut -f1); [ "${s:-0}" -gt $max ] && max=$s; sleep 0.1; done; echo "PEAK_BYTES=$max"
