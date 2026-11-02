#!/usr/bin/env node
// npx entry point.
//   npx .              start My Thari and open the main app
//   npx . party        start My Thari and open the party (mobile) app
//   npx my-thari-party same as "party"
const path = require("path");
const os = require("os");

const asParty = process.argv[2] === "party" || /party/.test(path.basename(process.argv[1] || ""));
if (process.argv[2] === "party") process.argv.splice(2, 1);

process.env.OPEN_BROWSER = process.env.OPEN_BROWSER || "1";
if (asParty) process.env.OPEN_PATH = "/party.html";

const port = process.env.PORT || 3000;
const lan = Object.values(os.networkInterfaces()).flat().find(i => i && i.family === "IPv4" && !i.internal);
if (lan) console.log(`On your phone (same Wi-Fi): http://${lan.address}:${port}${asParty ? "/party.html" : ""}`);

require(path.join(__dirname, "..", "launcher.js"));
