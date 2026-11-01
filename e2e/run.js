// Runs the Selenium suite: node e2e/run.js [spec-name-filter]
// First time: npm run e2e:install (installs selenium-webdriver into e2e/node_modules). Needs Chrome installed;
// selenium-manager downloads the matching chromedriver on first use. HEADED=1 shows the browser.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dir = __dirname;
if (!fs.existsSync(path.join(dir, "node_modules", "selenium-webdriver"))) {
  console.error('selenium-webdriver is not installed. Run "npm run e2e:install" first.');
  process.exit(2);
}
const filter = process.argv[2];
const specs = fs.readdirSync(path.join(dir, "specs")).filter(f => f.endsWith(".spec.js") && (!filter || f.includes(filter))).sort().map(f => path.join(dir, "specs", f));
if (!specs.length) { console.error("No spec matches " + filter); process.exit(2); }
fs.rmSync(path.join(dir, "artifacts"), { recursive: true, force: true });
const r = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=240000", ...specs], { stdio: "inherit", env: process.env });
if (r.status) console.error(`\nFailures leave screenshots in e2e/artifacts/.`);
process.exit(r.status ?? 1);
