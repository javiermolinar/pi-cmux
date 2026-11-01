import { randomBytes } from "node:crypto";
import { shellQuote, SSH_MAX_OUTPUT } from "./transport.ts";

export type SshFileOperation = "read" | "write" | "mkdir" | "access" | "edit-access" | "home";

/** No response bytes, paths or shell diagnostics are included in this error. */
export class SshFileProtocolError extends Error {
	readonly uncertain: boolean;
	constructor(mutating: boolean) {
		super("Invalid SSH file response" + (mutating ? "; remote effects may have occurred; do not automatically retry" : ""));
		this.name = "SshFileProtocolError";
		this.uncertain = mutating;
	}
}

export interface SshFileCommand {
	readonly script: string;
	readonly mutating: boolean;
	readonly headerPrefix: string;
	readonly trailer: string;
	readonly decode: (stdout: Buffer) => Buffer;
}

/**
 * File operations and the fixed remote-home query, not interactive/user bash output. Requires bash, cat,
 * mkdir, test and POSIX wc. No encoding utility, remote tempfile or replay.
 * Callers must still check transport authority, exit status and stderr policy.
 * An invalid mutation acknowledgement does not establish whether effects occurred.
 */
export function createFileCommand(operation: SshFileOperation, absolutePath: string): Readonly<SshFileCommand> {
	if (typeof absolutePath !== "string" || !absolutePath.startsWith("/") || absolutePath.includes("\0")) {
		throw new Error("Invalid absolute SSH file path");
	}
	const path = shellQuote(absolutePath);
	const mutating = operation === "write" || operation === "mkdir";
	const nonce = randomBytes(24).toString("hex");
	const headerPrefix = `PI_CMUX_SSH_FILE_V1:${nonce}:`;
	const trailer = `\nPI_CMUX_SSH_FILE_END_V1:${nonce}\n`;
	const headerBytes = Buffer.from(headerPrefix, "ascii");
	const trailerBytes = Buffer.from(trailer, "ascii");
	const ack = `printf '%s0\\n%s' ${shellQuote(headerPrefix)} ${shellQuote(trailer)}`;
	let script: string;
	switch (operation) {
		case "read":
			// wc may pad its decimal count. Only its documented blank padding is
			// accepted; arbitrary stdout is never treated as metadata or stripped.
			script = [
				`__pi_file_length=$(LC_ALL=C wc -c < ${path}) || exit $?`,
				`[[ "$__pi_file_length" =~ ^[[:blank:]]*([0-9]+)[[:blank:]]*$ ]] || exit 1`,
				`__pi_file_length=\${BASH_REMATCH[1]}`,
				`printf '%s%s\\n' ${shellQuote(headerPrefix)} "$__pi_file_length" || exit $?`,
				`cat -- ${path} || exit $?`,
				`printf '%s' ${shellQuote(trailer)}`,
			].join("\n");
			break;
		case "home":
			// HOME comes from the remote account environment. Never interpolate it
			// into executable text or expand a local home directory.
			script = [
				`LC_ALL=C`,
				`__pi_home=\${HOME-}`,
				`[[ "$__pi_home" = /* ]] || exit 1`,
				`printf '%s%s\\n' ${shellQuote(headerPrefix)} "\${#__pi_home}" || exit $?`,
				`printf '%s' "$__pi_home" || exit $?`,
				`printf '%s' ${shellQuote(trailer)}`,
			].join("\n");
			break;
		case "write":
			script = `cat > ${path} || exit $?\n${ack}`;
			break;
		case "mkdir":
			script = `mkdir -p -- ${path} || exit $?\n${ack}`;
			break;
		case "access":
			script = `test -r ${path} || exit $?\n${ack}`;
			break;
		case "edit-access":
			script = `test -r ${path} || exit $?\ntest -w ${path} || exit $?\n${ack}`;
			break;
		default:
			throw new Error("Invalid SSH file operation");
	}

	const decode = (stdout: Buffer): Buffer => {
		const fail = (): never => { throw new SshFileProtocolError(mutating); };
		if (!Buffer.isBuffer(stdout) || stdout.length > SSH_MAX_OUTPUT
			|| stdout.length < headerBytes.length + 2 + trailerBytes.length
			|| !stdout.subarray(0, headerBytes.length).equals(headerBytes)) return fail();

		// Parse bounded ASCII bytes, never UTF-8 text or a length-sized allocation.
		let cursor = headerBytes.length;
		const first = cursor;
		let length = 0;
		const maxDigits = String(SSH_MAX_OUTPUT).length;
		while (cursor < stdout.length && stdout[cursor] !== 10) {
			const digit = stdout[cursor] - 48;
			if (cursor - first >= maxDigits || digit < 0 || digit > 9
				|| (cursor > first && stdout[first] === 48)) return fail();
			length = length * 10 + digit;
			if (length > SSH_MAX_OUTPUT) return fail();
			cursor++;
		}
		if (cursor === first || stdout[cursor] !== 10 || (operation !== "read" && operation !== "home" && length !== 0)) return fail();
		const payloadStart = cursor + 1;
		const payloadEnd = payloadStart + length;
		if (payloadEnd + trailerBytes.length !== stdout.length
			|| !stdout.subarray(payloadEnd).equals(trailerBytes)) return fail();
		return Buffer.from(stdout.subarray(payloadStart, payloadEnd));
	};
	return Object.freeze({ script, mutating, headerPrefix, trailer, decode });
}
