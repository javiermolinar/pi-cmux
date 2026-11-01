// Shared, opt-in panel installation primitives. Node built-ins only.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, constants, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function readBundledPanel() {
  return readFileSync(new URL("../examples/sidebars/agent-state-panel.js", import.meta.url), "utf8");
}

export function renderInstalledPanel(source = readBundledPanel()) {
  return `// pi-cmux managed panel; version=1; sha256=${sha256(source)}\n` + source;
}

// Identity hashes always cover raw file bytes, including invalid UTF-8. Decoded
// text is for inspection only, never replacement authorization.
export function inspectInstalledPanel(target) {
  let stat;
  try { stat = lstatSync(target); }
  catch (error) { if (error.code === "ENOENT") return { status: "missing" }; throw error; }
  if (!stat.isFile()) return { status: "non-file", kind: stat.isSymbolicLink() ? "symlink" : "other" };
  const bytes = readFileSync(target);
  const content = bytes.toString("utf8"), hash = sha256(bytes), mode = stat.mode & 0o7777;
  const currentHash = sha256(readBundledPanel());
  const header = /^\/\/ pi-cmux managed panel; version=(\d+); sha256=([a-f0-9]{64})\n/.exec(content);
  if (!header) return { status: "modified", legacy: true, content, hash, mode, currentHash };
  const bodyHash = sha256(bytes.subarray(Buffer.byteLength(header[0], "utf8")));
  const version = Number(header[1]);
  const recordedHash = header[2];
  const status = bodyHash !== recordedHash ? "modified"
    : version === 1 && bodyHash === currentHash ? "current" : "outdated";
  return { status, legacy: false, content, hash, mode, version, recordedHash, bodyHash, currentHash };
}

export function installSidebar(target, content, expectedHash) {
  mkdirSync(dirname(target), { recursive: true });
  const desired = Buffer.from(content, "utf8");
  let existing, mode;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile()) throw new Error("Refusing to replace a symlink or non-file sidebar");
    mode = stat.mode & 0o7777;
    existing = readFileSync(target);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing?.equals(desired)) return { changed: false };
  if (existing === undefined) {
    writeFileSync(target, desired, { flag: "wx", mode: 0o600 });
    return { changed: true };
  }
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) || sha256(existing) !== expectedHash) {
    throw new Error("Sidebar exists; inspect it and pass --replace <its-sha256> to explicitly update it");
  }
  const backup = target + ".backup-" + Date.now();
  copyFileSync(target, backup, constants.COPYFILE_EXCL);
  chmodSync(backup, mode);
  const temporary = target + ".tmp-" + process.pid;
  let temporaryCreated = false;
  try {
    // Write privately, then preserve the approved permissions explicitly so the
    // caller's umask cannot silently remove bits from an existing file.
    writeFileSync(temporary, desired, { flag: "wx", mode: 0o600 });
    temporaryCreated = true;
    const current = lstatSync(target);
    if (!current.isFile() || (current.mode & 0o7777) !== mode || sha256(readFileSync(target)) !== expectedHash) {
      throw new Error("Sidebar changed during installation; not replacing it");
    }
    chmodSync(temporary, mode);
    renameSync(temporary, target);
  } finally { if (temporaryCreated) rmSync(temporary, { force: true }); }
  return { changed: true, backup };
}
