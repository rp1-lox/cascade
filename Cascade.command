#!/bin/sh
# Cascade launcher for macOS — DOUBLE-CLICK THIS FILE.
# (macOS opens .command files in Terminal; it will not run a .sh on double-click.)

cd "$(dirname "$0")" || exit 1

# Find a usable Python 3. macOS does not ship python3 unless the Xcode Command
# Line Tools or a python.org/Homebrew build is installed, so check the usual spots.
PY=""
for cand in \
    ./python/bin/python3 \
    python3 \
    /opt/homebrew/bin/python3 \
    /usr/local/bin/python3 \
    /usr/bin/python3 \
    python3.13 python3.12 python3.11 python3.10 python3.9
do
    if command -v "$cand" >/dev/null 2>&1; then PY="$cand"; break; fi
    if [ -x "$cand" ]; then PY="$cand"; break; fi
done

if [ -z "$PY" ]; then
    echo ""
    echo "  Cascade needs Python 3, and none was found."
    echo ""
    echo "  Easiest fix - run this in Terminal, then double-click Cascade.command again:"
    echo ""
    echo "      xcode-select --install"
    echo ""
    echo "  (That installs Apple's Command Line Tools, which include python3.)"
    echo "  Or install Python from https://www.python.org/downloads/macos/"
    echo ""
    printf "  Press Return to close..."
    read -r _dummy
    exit 1
fi

echo "Using Python: $PY"
"$PY" launch.py
STATUS=$?

echo ""
if [ $STATUS -ne 0 ]; then
    echo "  Cascade exited with an error (code $STATUS). The messages above say why."
else
    echo "  Cascade stopped."
fi
printf "  Press Return to close..."
read -r _dummy
