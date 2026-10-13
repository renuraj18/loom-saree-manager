// Clears the data (warps, looms, deliveries, stock, parties) of every factory. Factories and
// user accounts are kept. A full backup is saved first, so a reset can be undone from
// Settings > Backups > Restore. Safe to run while the app is open; refresh the browser afterwards.
const readline = require("readline");
const { backupConfig } = require("../paths");
const store = require("../store");
const { snapshot } = require("../backup");

const { factories } = store.readAccounts();
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`This clears ALL warps, looms, deliveries, stock and parties in ${factories.length} factor${factories.length === 1 ? "y" : "ies"}:`);
for (const f of factories) console.log(`  - ${f.name}`);
console.log("Factories and user accounts are kept.");
console.log(`A full backup is saved first in: ${backupConfig().dir}`);
rl.question('Type RESET and press Enter to continue (anything else cancels): ', answer => {
  rl.close();
  if (answer.trim() !== "RESET") {
    console.log("Cancelled. Nothing was changed.");
    return;
  }
  const saved = snapshot("before-reset");
  for (const f of factories) store.writeFactoryRaw(f.id, store.emptyFactoryData());
  console.log(`Done. Previous data saved as: ${saved}`);
  console.log("Refresh the browser if the app is open.");
});
