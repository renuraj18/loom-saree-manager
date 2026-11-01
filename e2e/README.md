# Browser tests (Selenium)

Drives the real app in headless Chrome, one throwaway server per spec file. Run before a release.

```bash
npm run e2e:install          # once: installs selenium-webdriver into e2e/node_modules
npm run test:e2e             # all specs      (or ./e2e/run-e2e.sh)
./e2e/run-e2e.sh 02          # specs whose filename contains "02"
HEADED=1 ./e2e/run-e2e.sh 01 # watch the browser
```

Needs Chrome installed (selenium-manager fetches the matching chromedriver on first use). A failing test saves a screenshot in `e2e/artifacts/` (git-ignored).
