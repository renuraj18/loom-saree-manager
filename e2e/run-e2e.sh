#!/usr/bin/env bash
# Runs the Selenium suite.  Usage:
#   ./e2e/run-e2e.sh            run every spec (headless)
#   ./e2e/run-e2e.sh 01         run specs whose filename contains "01"
#   HEADED=1 ./e2e/run-e2e.sh   watch the browser
set -euo pipefail
cd "$(dirname "$0")/.."

command -v node >/dev/null || { echo "Node.js is required (>= 18)."; exit 2; }

# One-time install of selenium-webdriver (kept in e2e/node_modules, apart from the app).
if [ ! -d e2e/node_modules/selenium-webdriver ]; then
  echo "Installing selenium-webdriver..."
  npm --prefix e2e install --no-audit --no-fund
fi

node e2e/run.js "$@"
