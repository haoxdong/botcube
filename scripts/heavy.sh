#!/bin/sh
# Runs one Node-heavy command under the machine-wide lock, so agents sharing a Mac run one at a time (docs/testing.md).
# Linux (CI, Codex Cloud) has no lockf and runs the command directly; a nested call reuses its parent's lock.
script_root=$(cd "${0%/*}/.." && pwd)
if [ -f "$script_root/../pnpm-workspace.yaml" ]; then
  script_root=$(cd "$script_root/.." && pwd)
fi
export NPM_CONFIG_WORKSPACE_DIR=${NPM_CONFIG_WORKSPACE_DIR:-$script_root}
lock=${HEAVY_LOCK_PATH:-/tmp/collective-heavy.lock}
if [ -z "$HEAVY_LOCK_HELD" ] && command -v lockf >/dev/null 2>&1; then
  export HEAVY_LOCK_HELD=1
  # While the lock is busy, name its holder and queue on stderr. macOS lockf forks its command only once it
  # holds the lock, so a lockf with a child is the holder and one without is queued. A stopped (SIGSTOP)
  # process in the holder's tree would stall every queued call, so print those pids to resume them.
  processes=$(ps -A -o pid=,ppid=,stat=,etime=,command=) || {
    echo "heavy.sh: process inspection failed" >&2
    exit 1
  }
  stopped=$(printf '%s\n' "$processes" | awk -v lock="$lock" '
    function seconds(t,   p, n, d) {
      d = 0
      if (t ~ /-/) { split(t, p, "-"); d = p[1]; t = p[2] }
      n = split(t, p, ":")
      return d * 86400 + (n == 3 ? p[1] * 3600 + p[2] * 60 + p[3] : p[1] * 60 + p[2])
    }
    {
      state[$1] = $3; age[$1] = $4; kids[$2] = kids[$2] " " $1
      if ($5 ~ /(^|\/)lockf$/ && $6 == "-k" && $7 == lock) locker[$1] = substr($0, index($0, lock) + length(lock) + 1)
    }
    END {
      queued = 0
      for (l in locker) if (kids[l] != "") holder = l; else queued++
      if (holder == "") exit
      split(kids[holder], child, " ")
      printf "heavy.sh: waiting for %s, held by pid %s (%s) for %d s; %d other(s) queued\n", lock, holder, locker[holder], seconds(age[child[1]]), queued > "/dev/stderr"
      todo = " " holder
      while (todo != "") {
        n = split(todo, q, " "); todo = ""
        for (i = 1; i <= n; i++) { if (state[q[i]] ~ /T/) stopped = stopped " " q[i]; todo = todo kids[q[i]] }
      }
      print substr(stopped, 2)
    }') || {
    echo "heavy.sh: lock inspection failed" >&2
    exit 1
  }
  if [ -n "$stopped" ]; then
    echo "heavy.sh: the lock holder was stopped; sending SIGCONT to pid(s) $stopped" >&2
    # shellcheck disable=SC2086 # one argument per pid
    kill -CONT $stopped || {
      echo "heavy.sh: failed to resume stopped lock holder" >&2
      exit 1
    }
  fi
  exec lockf -k "$lock" "$@"
fi
exec "$@"
