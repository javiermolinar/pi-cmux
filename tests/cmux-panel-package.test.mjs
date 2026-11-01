import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installSidebar, inspectInstalledPanel, readBundledPanel, renderInstalledPanel, sha256 } from "../lib/panel-install.mjs";
import { renderSidebar, installSidebar as legacyInstall, sha256 as legacyHash } from "../examples/sidebars/install-agent-state-panel.mjs";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "pi-cmux-panel-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("managed rendering and inspection validate body, not just declared header", (t) => {
  const target = join(fixture(t), "panel.js");
  const source = readBundledPanel();
  const rendered = renderInstalledPanel();
  assert.equal(rendered, renderInstalledPanel(source));
  assert.ok(rendered.endsWith(source));
  assert.doesNotMatch(rendered, /const PI_PANEL_LAUNCH\s*=/);
  assert.deepEqual(inspectInstalledPanel(target), { status: "missing" });
  installSidebar(target, rendered);
  let info = inspectInstalledPanel(target);
  assert.equal(info.status, "current");
  assert.equal(info.content, rendered);
  assert.equal(info.hash, sha256(rendered));
  assert.equal(info.bodyHash, sha256(source));
  assert.equal(info.recordedHash, info.currentHash);
  // A managed header cannot legitimize damaged bytes that decode to the same
  // text. Body checksums, like replacement hashes, must use the raw bytes.
  const decodedBody = "// \ufffd\n";
  const damaged = Buffer.concat([
    Buffer.from(`// pi-cmux managed panel; version=1; sha256=${sha256(decodedBody)}\n`),
    Buffer.from([0x2f, 0x2f, 0x20, 0x80, 0x0a]),
  ]);
  writeFileSync(target, damaged);
  assert.equal(inspectInstalledPanel(target).status, "modified");
  assert.equal(inspectInstalledPanel(target).hash, sha256(damaged));
  writeFileSync(target, rendered + "\n// edited");
  assert.equal(inspectInstalledPanel(target).status, "modified");
  writeFileSync(target, renderInstalledPanel("// old asset\n"));
  assert.equal(inspectInstalledPanel(target).status, "outdated");
  writeFileSync(target, rendered.replace("version=1", "version=2"));
  assert.equal(inspectInstalledPanel(target).status, "outdated");
  writeFileSync(target, renderSidebar(source, { bridge: "/old/worktree" }));
  info = inspectInstalledPanel(target);
  assert.equal(info.status, "modified");
  assert.equal(info.legacy, true);
  assert.throws(() => installSidebar(target, rendered), /--replace/);
  const result = installSidebar(target, rendered, info.hash);
  assert.equal(readFileSync(result.backup, "utf8"), info.content);
  assert.equal(inspectInstalledPanel(target).status, "current");
  assert.deepEqual(installSidebar(target, rendered), { changed: false });
  assert.equal(legacyInstall, installSidebar);
  assert.equal(legacyHash, sha256);
});

test("safe shared installer preserves non-files and exclusive collisions", (t) => {
  const dir = fixture(t);
  const target = join(dir, "panel.js");
  const content = renderInstalledPanel();
  mkdirSync(target);
  assert.equal(inspectInstalledPanel(target).status, "non-file");
  assert.throws(() => installSidebar(target, content), /non-file/);
  rmSync(target, { recursive: true });
  const referent = join(dir, "referent");
  writeFileSync(referent, "untouched");
  symlinkSync(referent, target);
  assert.deepEqual(inspectInstalledPanel(target), { status: "non-file", kind: "symlink" });
  assert.throws(() => installSidebar(target, content), /non-file/);
  assert.equal(readFileSync(referent, "utf8"), "untouched");
  rmSync(target);
  installSidebar(target, "old");
  assert.throws(() => installSidebar(target, content, sha256("wrong")), /--replace/);
  const temporary = target + ".tmp-" + process.pid;
  writeFileSync(temporary, "collision");
  assert.throws(() => installSidebar(target, content, sha256("old")), { code: "EEXIST" });
  assert.equal(readFileSync(temporary, "utf8"), "collision");
  assert.equal(readFileSync(target, "utf8"), "old");
  const backup = readdirSync(dir).find((name) => name.startsWith("panel.js.backup-"));
  assert.ok(backup);
  assert.equal(readFileSync(join(dir, backup), "utf8"), "old");
});

test("actual npm pack includes only canonical example and installs unpacked without dependencies", (t) => {
  const dir = fixture(t);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = execFileSync("npm", ["pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", dir], {
    cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: join(dir, "npm-cache") },
  });
  const [pack] = JSON.parse(output);
  const files = pack.files.map((entry) => entry.path);
  assert.ok(files.includes("lib/panel-install.mjs"));
  assert.deepEqual(files.filter((name) => name.startsWith("examples/") && !name.endsWith("/README.md")),
    ["examples/sidebars/agent-state-panel.js"], "npm may also include the asset directory's README, but no bridge or installer");
  const unpacked = join(dir, "unpacked");
  mkdirSync(unpacked);
  execFileSync("tar", ["-xzf", join(dir, pack.filename), "-C", unpacked]);
  const helper = pathToFileURL(join(unpacked, "package/lib/panel-install.mjs")).href;
  // A fresh Node process in a fixture cwd has no repository imports or installed
  // dependencies. Both first install and confirmed update use only tarball files.
  const script = `
    import assert from 'node:assert/strict';
    import { readFileSync, chmodSync, statSync } from 'node:fs';
    import { installSidebar, inspectInstalledPanel, readBundledPanel, renderInstalledPanel } from ${JSON.stringify(helper)};
    const target = ${JSON.stringify(join(dir, "config/sidebars/agent-state-panel.js"))};
    const old = renderInstalledPanel('// previous package asset\\n');
    installSidebar(target, old);
    chmodSync(target, 0o400);
    const before = inspectInstalledPanel(target);
    assert.equal(before.status, 'outdated');
    assert.throws(() => installSidebar(target, renderInstalledPanel()), /--replace/);
    const result = installSidebar(target, renderInstalledPanel(), before.hash);
    assert.equal(readFileSync(result.backup, 'utf8'), old);
    assert.equal(statSync(target).mode & 0o7777, 0o400);
    assert.equal(statSync(result.backup).mode & 0o7777, 0o400);
    assert.equal(inspectInstalledPanel(target).status, 'current');
    assert.equal(readFileSync(target, 'utf8'), renderInstalledPanel(readBundledPanel()));
    assert.deepEqual(installSidebar(target, renderInstalledPanel()), { changed: false });
    assert.doesNotMatch(readFileSync(target, 'utf8'), /const PI_PANEL_LAUNCH\\s*=/);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: unpacked, encoding: "utf8" });
});
