# Shared shell helpers. Sourced, not executed.

# Resolve a working Python interpreter.
#
# `command -v python3` is not sufficient on Windows: the App Execution Alias
# puts a python3 stub on PATH that exists, resolves, and then fails at runtime
# with "Python was not found; run without arguments to install from the
# Microsoft Store". So each candidate is probed by actually running it.
aegis_find_python() {
  local candidate
  for candidate in "${AEGIS_PYTHON:-}" python3 python py; do
    [ -n "$candidate" ] || continue
    if command -v "$candidate" >/dev/null 2>&1 \
       && "$candidate" -c "import sys; sys.exit(0)" >/dev/null 2>&1; then
      command -v "$candidate"
      return 0
    fi
  done

  echo "No working Python 3 interpreter found (tried python3, python, py)." >&2
  echo "Set AEGIS_PYTHON to the interpreter you want used." >&2
  return 1
}
