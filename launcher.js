// Runs server.js and starts it again when it exits with RESTART_EXIT_CODE (the Admin
// page's "Restart app"). Any other exit ends the launcher with the same code.
//   npm start  ->  node launcher.js
const { fork } = require("child_process");
const path = require("path");

const RESTART_EXIT_CODE = 75;
let child;

function start() {
  child = fork(path.join(__dirname, "server.js"), process.argv.slice(2), {
    env: { ...process.env, LOOM_SUPERVISED: "1" },
    stdio: "inherit"
  });
  child.on("exit", code => {
    if (code === RESTART_EXIT_CODE) {
      console.log("Restarting My Thari…");
      // Only open the browser on the first start, not on every restart.
      delete process.env.OPEN_BROWSER;
      return start();
    }
    process.exit(code ?? 0);
  });
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { if (child) child.kill(signal); else process.exit(0); });
}
start();
