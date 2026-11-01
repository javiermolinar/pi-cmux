import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createFileCommand, SshFileProtocolError } from "../lib/ssh/file-protocol.ts";
import { SSH_MAX_OUTPUT, shellQuote } from "../lib/ssh/transport.ts";

const operations = ["read", "write", "mkdir", "access", "edit-access"];
const frame = (command, payload = Buffer.alloc(0), length = String(payload.length)) => Buffer.concat([
	Buffer.from(`${command.headerPrefix}${length}\n`, "ascii"), payload, Buffer.from(command.trailer, "ascii"),
]);
function refused(command, bytes) {
	assert.throws(() => command.decode(bytes), (error) => {
		assert.ok(error instanceof SshFileProtocolError);
		assert.equal(error.name, "SshFileProtocolError");
		assert.equal(error.message, "Invalid SSH file response" + (command.mutating ? "; remote effects may have occurred; do not automatically retry" : ""));
		assert.equal(error.uncertain, command.mutating);
		assert.doesNotMatch(error.message, /PRIVATE|notice/);
		if (command.mutating) assert.match(error.message, /do not automatically retry/);
		return true;
	});
}
// These are disposable local bash processes, not SSH, native resources or
// integration tests. Utilities are stubbed where necessary; no fixture files,
// remote tempfiles, deletions or cleanup are needed. Only /dev/null is written.
function run(command, { before = "", input = Buffer.alloc(0) } = {}) {
	const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", `${before}\n${command.script}`], {
		input, env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, maxBuffer: SSH_MAX_OUTPUT + 1024,
	});
	assert.ifError(result.error);
	assert.equal(result.signal, null);
	return result;
}

test("commands are frozen and each command has fresh immutable ASCII nonce metadata", () => {
	const nonces = new Set();
	for (const operation of operations) {
		for (let i = 0; i < 10; i++) {
			const command = createFileCommand(operation, "/PRIVATE/path");
			assert.ok(Object.isFrozen(command));
			assert.equal(command.mutating, operation === "write" || operation === "mkdir");
			const nonce = /^PI_CMUX_SSH_FILE_V1:([0-9a-f]{48}):$/.exec(command.headerPrefix)?.[1];
			assert.ok(nonce);
			assert.equal(command.trailer, `\nPI_CMUX_SSH_FILE_END_V1:${nonce}\n`);
			assert.ok(!nonces.has(nonce)); nonces.add(nonce);
			assert.throws(() => { command.headerPrefix = "changed"; }, TypeError);
			assert.throws(() => { command.decode = () => Buffer.alloc(0); }, TypeError);
		}
	}
	for (const path of ["relative", "", "~/file", "/a\0b", null, 42]) {
		assert.throws(() => createFileCommand("read", path), /Invalid absolute SSH file path/);
	}
	assert.throws(() => createFileCommand("unknown", "/file"), /Invalid SSH file operation/);
});

test("reads preserve empty, arbitrary binary, Unicode and marker-like bytes exactly", () => {
	const command = createFileCommand("read", "/file");
	for (const payload of [
		Buffer.alloc(0), Buffer.from([0, 255, 128, 13, 10, 0]),
		Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
		Buffer.from("café 🦀 漢字 e\u0301\n\0", "utf8"),
		Buffer.from(`${command.trailer}${command.headerPrefix}0\n${command.trailer}\n`),
	]) {
		const encoded = frame(command, payload);
		const decoded = command.decode(encoded);
		assert.deepEqual(decoded, payload);
		encoded.fill(0); // Decoded bytes are independent of the transport buffer.
		assert.deepEqual(decoded, payload);
	}
});

test("decoder refuses noise, wrong nonces, corrupt trailers, extra frames and every truncation", () => {
	const command = createFileCommand("read", "/PRIVATE/file");
	const other = createFileCommand("read", "/PRIVATE/file");
	const payload = Buffer.from("secret\0bytes\n");
	const valid = frame(command, payload);
	for (let length = 0; length < valid.length; length++) refused(command, valid.subarray(0, length));
	for (const bad of [
		Buffer.concat([Buffer.from("account notice\n"), valid]),
		Buffer.concat([valid, Buffer.from("notice")]),
		Buffer.concat([valid, Buffer.from([0])]),
		Buffer.concat([valid, valid]),
		frame(other, payload),
		Buffer.concat([Buffer.from(`${command.headerPrefix}${payload.length}\n`), payload, Buffer.from(other.trailer)]),
		frame(command, payload, String(payload.length - 1)),
		frame(command, payload, String(payload.length + 1)),
		Buffer.from(valid.toString("utf8").replace(command.trailer, command.trailer.toUpperCase())),
	]) refused(command, bad);
	// High-bit bytes must not be folded into ASCII by a text decoder.
	const badDigit = frame(command, Buffer.from("x"));
	badDigit[Buffer.byteLength(command.headerPrefix)] = 0xb1;
	refused(command, badDigit);
	const badHeader = Buffer.from(valid); badHeader[0] ^= 0x80;
	refused(command, badHeader);
});

test("length parsing accepts only bounded canonical decimal and exact total output size", () => {
	const command = createFileCommand("read", "/file");
	for (const length of ["", "00", "01", "-1", "+1", " 1", "1 ", "1\r", "1\n0", "1.0", "1e0", "0x1",
		"NaN", "Infinity", "١", "１", String(SSH_MAX_OUTPUT + 1), "9".repeat(100_000)]) {
		refused(command, frame(command, Buffer.from("x"), length));
	}
	refused(command, Buffer.from(`${command.headerPrefix}1`)); // Missing length delimiter.
	refused(command, Buffer.alloc(SSH_MAX_OUTPUT + 1));
	let size = SSH_MAX_OUTPUT - command.headerPrefix.length - command.trailer.length - 1;
	size -= String(size).length;
	const payload = Buffer.alloc(size, 0xab);
	const maximum = frame(command, payload);
	assert.equal(maximum.length, SSH_MAX_OUTPUT);
	assert.deepEqual(command.decode(maximum), payload);
	refused(command, frame(command, Buffer.alloc(size + 1)));
	// A payload equal to the limit cannot fit with the framing overhead.
	refused(command, frame(command, Buffer.alloc(0), String(SSH_MAX_OUTPUT)));
});

test("only reads may carry data; all malformed mutation acknowledgements are uncertain", () => {
	for (const operation of operations.filter((op) => op !== "read")) {
		const command = createFileCommand(operation, "/PRIVATE/file");
		assert.deepEqual(command.decode(frame(command)), Buffer.alloc(0));
		for (const bad of [Buffer.alloc(0), frame(command, Buffer.from("PRIVATE")),
			frame(command, Buffer.alloc(0), "00"), Buffer.concat([Buffer.from("notice\n"), frame(command)]),
			Buffer.concat([frame(command), Buffer.from("notice\n")]), frame(command).subarray(0, -1)]) {
			refused(command, bad);
		}
	}
});

test("real local bash emits zero-length frames and binary read bytes without encoding", () => {
	const empty = createFileCommand("read", "/dev/null");
	const emptyResult = run(empty);
	assert.equal(emptyResult.status, 0);
	assert.deepEqual(empty.decode(emptyResult.stdout), Buffer.alloc(0));
	const command = createFileCommand("read", "/dev/null");
	const input = Buffer.concat([Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
		Buffer.from(`\nUnicode café 🌍\n${command.trailer}${command.headerPrefix}0\n`)]);
	// wc still receives a literal redirected path; cat's stub passes binary stdin.
	const result = run(command, { input,
		before: `wc() { printf '   ${input.length}  \\n'; }; cat() { command cat; }`,
	});
	assert.equal(result.status, 0);
	assert.deepEqual(command.decode(result.stdout), input);
	assert.equal(result.stderr.length, 0);
});

test("the fixed home query frames the remote HOME literally with byte-correct Unicode lengths", () => {
	const command = createFileCommand("home", "/");
	for (const home of ["/home/remote", "/home/space ' café 🌍 $HOME $(printf BAD >&2) `printf BAD >&2`"]) {
		const result = run(command, { before: `HOME=${shellQuote(home)}` });
		assert.equal(result.status, 0);
		assert.equal(result.stderr.length, 0, "home contents are never evaluated");
		assert.equal(command.decode(result.stdout).toString("utf8"), home);
		refused(command, Buffer.concat([Buffer.from("notice\n"), result.stdout]));
		refused(command, Buffer.concat([result.stdout, Buffer.from("notice\n")]));
	}
	for (const before of ["unset HOME", "HOME=relative", "HOME=''"]) {
		const result = run(command, { before });
		assert.equal(result.status, 1); assert.equal(result.stdout.length, 0);
	}
});

test("writes keep binary and Unicode content exclusively on stdin", () => {
	const command = createFileCommand("write", "/dev/null");
	const input = Buffer.concat([Buffer.from([0, 255, 128]), Buffer.from("$HOME $(printf EXPANDED) ' café 🌍\n")]);
	// Observe cat's input on stderr without creating a file or altering the frame.
	const result = run(command, { input, before: "cat() { command cat >&2; };" });
	assert.equal(result.status, 0);
	assert.deepEqual(result.stderr, input);
	assert.deepEqual(command.decode(result.stdout), Buffer.alloc(0));
	assert.ok(!command.script.includes("EXPANDED"));
});

test("literal paths are never expanded, split, normalized or executed", () => {
	const path = "/space ' $HOME $(printf EXPANDED >&2) `printf EXPANDED >&2` \\ café\n-~/*?[x]";
	for (const operation of ["access", "edit-access", "mkdir"]) {
		const command = createFileCommand(operation, path);
		const result = run(command, { before:
			"test() { printf '%s\\0' \"$@\" >&2; }; mkdir() { printf '%s\\0' \"$@\" >&2; };",
		});
		assert.equal(result.status, 0);
		assert.deepEqual(command.decode(result.stdout), Buffer.alloc(0));
		const args = operation === "mkdir" ? ["-p", "--", path]
			: operation === "access" ? ["-r", path] : ["-r", path, "-w", path];
		assert.deepEqual(result.stderr, Buffer.from(args.join("\0") + "\0"));
	}
	const read = createFileCommand("read", path);
	const write = createFileCommand("write", path);
	// The shared quote routine must also enclose both read operands and write's
	// redirection; no content is embedded in any command.
	const quoted = "'" + path.replaceAll("'", "'\\''") + "'";
	assert.ok(read.script.includes(`wc -c < ${quoted}`));
	assert.ok(read.script.includes(`cat -- ${quoted} || exit $?`));
	assert.ok(write.script.startsWith(`cat > ${quoted} || exit $?\n`));
});

test("operations acknowledge only after success and preserve failing exit status", () => {
	for (const operation of operations) {
		const command = createFileCommand(operation, "/dev/null");
		const stub = operation === "read" ? "wc() { return 17; };"
			: operation === "write" ? "cat() { return 17; };"
			: operation === "mkdir" ? "mkdir() { return 17; };" : "test() { return 17; };";
		const result = run(command, { before: stub });
		assert.equal(result.status, 17);
		assert.equal(result.stdout.length, 0);
		refused(command, result.stdout);
	}
	const read = createFileCommand("read", "/dev/null");
	const catFailure = run(read, { before: "cat() { printf partial; return 23; };" });
	assert.equal(catFailure.status, 23);
	assert.ok(!catFailure.stdout.includes(Buffer.from(read.trailer)));
	refused(read, catFailure.stdout);
	const wcNoise = run(read, { before: "wc() { printf 'notice\\n0\\n'; };" });
	assert.equal(wcNoise.status, 1);
	assert.equal(wcNoise.stdout.length, 0);
	const edit = createFileCommand("edit-access", "/dev/null");
	const deniedWrite = run(edit, { before: 'test() { if [[ "$1" == -w ]]; then return 29; fi; };' });
	assert.equal(deniedWrite.status, 29);
	assert.equal(deniedWrite.stdout.length, 0);
});

test("successful effects precede acknowledgement; shell and operation stdout are rejected, not stripped", () => {
	const input = Buffer.from("binary\0stdin\xff café", "utf8");
	for (const operation of operations) {
		const command = createFileCommand(operation, "/dev/null");
		const stub = operation === "mkdir" ? 'mkdir() { printf EFFECT >&2; };'
			: operation === "write" ? 'cat() { command cat; printf EFFECT >&2; };' : "";
		// Only writes consume stdin. Other commands may exit before Node writes
		// the unused bytes, producing a spurious EPIPE on Linux.
		const stdin = operation === "write" ? input : Buffer.alloc(0);
		const success = run(command, { before: stub, input: stdin });
		assert.equal(success.status, 0);
		assert.deepEqual(command.decode(success.stdout), Buffer.alloc(0));
		if (command.mutating) assert.equal(success.stderr.toString(), "EFFECT");
		const noisy = run(command, { before: `printf 'account notice\\n'; ${stub}`, input: stdin });
		assert.equal(noisy.status, 0);
		refused(command, noisy.stdout);
		if (command.mutating) assert.equal(noisy.stderr.toString(), "EFFECT");
	}
	const read = createFileCommand("read", "/dev/null");
	const noisyRead = run(read, { before: "cat() { printf 'operation notice'; };" });
	assert.equal(noisyRead.status, 0);
	refused(read, noisyRead.stdout);
	const mkdir = createFileCommand("mkdir", "/dev/null");
	const noisyMkdir = run(mkdir, { before: "mkdir() { printf 'operation notice'; };" });
	assert.equal(noisyMkdir.status, 0);
	refused(mkdir, noisyMkdir.stdout);
	// Decode is a pure check: it cannot retry, replay, roll back or perform I/O.
	refused(mkdir, noisyMkdir.stdout);
});
