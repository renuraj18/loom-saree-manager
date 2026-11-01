// Vendor tool: creates the Ed25519 key pair used to sign license keys.
//   node scripts/license-keygen.js [path/to/license-private.pem]
// The private key (default: ~/.mythari/license-private.pem) signs licenses with scripts/issue-license.js.
// Keep it off the repository and back it up: losing it means you cannot issue or renew licenses for builds
// that carry its public key. The public key is written into license-key.js, which you commit and release.
// Re-running with a new key invalidates every license signed with the old one.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const out = path.resolve(process.argv[2] || path.join(os.homedir(), ".mythari", "license-private.pem"));
if (fs.existsSync(out)) { console.error(`${out} already exists. Delete it first if you really want a new key (old licenses stop working).`); process.exit(1); }
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
const pub = publicKey.export({ type: "spki", format: "pem" });
const keyFile = path.join(__dirname, "..", "license-key.js");
fs.writeFileSync(keyFile, `// The vendor's public key for checking license keys (license.js). Written by \`node scripts/license-keygen.js\`.
// Empty means this build accepts no license keys yet: installs run on the trial until the vendor key is added.
// The matching private key must never be committed.
module.exports = { PUBLIC_KEY: ${JSON.stringify(pub)} };
`);
console.log(`Private key: ${out}  (keep it safe, never commit it)`);
console.log(`Public key written to license-key.js. Commit and release it, then issue licenses with scripts/issue-license.js.`);
