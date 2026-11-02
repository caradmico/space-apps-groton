#!/usr/bin/env bash
set -u

for arg in "$@"; do
    case "$arg" in
        --upload|--overwrite|--upload=*|--overwrite=*)
            exit 4
            ;;
    esac
done

if [ "$#" -lt 2 ]; then
    exit 1
fi

OUTDIR="$1"
PREFIX="$2"
shift 2

if [ ! -f "${OUTDIR}/tap_cache/tap.json" ]; then
    echo "no checkpoint at ${OUTDIR}"
    exit 3
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PY_SCRIPT="${SCRIPT_DIR}/staris_run.py"
LOG_FILE="${OUTDIR}/resume.log"
PID_FILE="${OUTDIR}/run.pid"
EXIT_FILE="${OUTDIR}/run.exit"

rm -f "${EXIT_FILE}"

nohup setsid bash -c '
    exit_file="$1"
    shift
    "$@"
    echo $? > "${exit_file}.tmp"
    mv -f "${exit_file}.tmp" "${exit_file}"
' _ "${EXIT_FILE}" python3 "${PY_SCRIPT}" --out "${OUTDIR}" --prefix "${PREFIX}" --coarse "$@" >> "${LOG_FILE}" 2>&1 < /dev/null &

CHILD_PID=$!
echo "${CHILD_PID}" > "${PID_FILE}"

tail --pid="${CHILD_PID}" -f /dev/null

EXIT_CODE=1
if [ -f "${EXIT_FILE}" ]; then
    read -r EXIT_CODE < "${EXIT_FILE}" || EXIT_CODE=1
fi
case "${EXIT_CODE}" in
    ''|*[!0-9]*) EXIT_CODE=1 ;;
esac

if [ "${EXIT_CODE}" -eq 0 ]; then
    STATE="finished"
else
    STATE="failed"
fi

FINISHED_AT="$(date +%Y-%m-%dT%H:%M:%S%z)"

LAST_LOG_LINE=""
if [ -f "${LOG_FILE}" ]; then
    LAST_LOG_LINE="$(tail -n 1 "${LOG_FILE}" || true)"
fi

STATUS_DIR="/workspace/status"
STATUS_FILE="${STATUS_DIR}/staris-fullrun.json"
TMP_STATUS="${STATUS_FILE}.tmp.$$"

mkdir -p "${STATUS_DIR}"

python3 -c '
import json, sys
data = {
    "state": sys.argv[1],
    "exit_code": int(sys.argv[2]),
    "finished_at": sys.argv[3],
    "outdir": sys.argv[4],
    "last_log_line": sys.argv[5]
}
with open(sys.argv[6], "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
' "${STATE}" "${EXIT_CODE}" "${FINISHED_AT}" "${OUTDIR}" "${LAST_LOG_LINE}" "${TMP_STATUS}"

mv -f "${TMP_STATUS}" "${STATUS_FILE}"
