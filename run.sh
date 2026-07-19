#!/bin/sh
# KSP Engine Editor launcher (Linux/macOS).
#   chmod +x run.sh   then   ./run.sh
cd "$(dirname "$0")" || exit 1
if [ -x "python/bin/python3" ]; then
    exec python/bin/python3 launch.py
elif command -v python3 >/dev/null 2>&1; then
    exec python3 launch.py
else
    echo "ERROR: python3 not found. Install Python 3 (most Linux/macOS systems already have it)."
    exit 1
fi
