#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "pi-cmux";
const AGENT_DIR = path.join(os.homedir(), ".pi", "agent");
const SETTINGS_PATH = path.join(AGENT_DIR, "settings.json");
const LEGACY_EXTENSION_DIR = path.join(AGENT_DIR, "extensions", PACKAGE_NAME);
const PACKAGE_DIR = path.join(AGENT_DIR, "packages", PACKAGE_NAME);
const PACKAGE_SETTINGS_ENTRY = `./packages/${PACKAGE_NAME}`;
const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const FILES_TO_COPY = ["package.json", "README.md", "CHANGELOG.md", "examples/sidebars/agent-state-panel.js"];
const DIRECTORIES_TO_COPY = ["extensions", "lib", "docs"];

const args = process.argv.slice(2);
const isRemove = args.includes("--remove") || args.includes("-r");
const isHelp = args.includes("--help") || args.includes("-h");

function printHelp() {
	console.log(`\n${PACKAGE_NAME}\n\nWhy:\n  pi-cmux adds cmux-powered terminal integrations to pi.\n\nUsage:\n  npx ${PACKAGE_NAME}          Install or update the extension package\n  npx ${PACKAGE_NAME} --remove Remove the installed extension package\n  npx ${PACKAGE_NAME} --help   Show this help\n`);
}

function ensureDir(dir) {
	fs.mkdirSync(dir, { recursive: true });
}

function readSettings() {
	if (!fs.existsSync(SETTINGS_PATH)) {
		return {};
	}
	return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
}

function writeSettings(settings) {
	ensureDir(path.dirname(SETTINGS_PATH));
	fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
}

function ensurePackageSettingsEntry() {
	const settings = readSettings();
	const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
	if (!packages.includes(PACKAGE_SETTINGS_ENTRY)) {
		packages.push(PACKAGE_SETTINGS_ENTRY);
	}
	settings.packages = packages;
	writeSettings(settings);
}

function removePackageSettingsEntry() {
	if (!fs.existsSync(SETTINGS_PATH)) {
		return;
	}
	const settings = readSettings();
	if (!Array.isArray(settings.packages)) {
		return;
	}
	settings.packages = settings.packages.filter((entry) => entry !== PACKAGE_SETTINGS_ENTRY && entry !== `./extensions/${PACKAGE_NAME}`);
	writeSettings(settings);
}

function removeLegacyInstall() {
	if (fs.existsSync(LEGACY_EXTENSION_DIR)) {
		fs.rmSync(LEGACY_EXTENSION_DIR, { recursive: true, force: true });
	}
}

function copyInstall() {
	removeLegacyInstall();
	fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
	ensureDir(PACKAGE_DIR);
	for (const file of FILES_TO_COPY) {
		const destination = path.join(PACKAGE_DIR, file);
		ensureDir(path.dirname(destination));
		fs.copyFileSync(path.join(SOURCE_DIR, file), destination);
	}
	for (const dir of DIRECTORIES_TO_COPY) {
		fs.cpSync(path.join(SOURCE_DIR, dir), path.join(PACKAGE_DIR, dir), { recursive: true });
	}
	ensurePackageSettingsEntry();
}

if (isHelp) {
	printHelp();
	process.exit(0);
}

if (isRemove) {
	const hadPackageDir = fs.existsSync(PACKAGE_DIR);
	const hadLegacyDir = fs.existsSync(LEGACY_EXTENSION_DIR);
	if (hadPackageDir) {
		fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });
	}
	removeLegacyInstall();
	removePackageSettingsEntry();
	if (hadPackageDir || hadLegacyDir) {
		console.log(`Removed ${PACKAGE_NAME} from ${AGENT_DIR}`);
	} else {
		console.log("Extension package is not installed");
	}
	process.exit(0);
}

copyInstall();
console.log(`Installed to ${PACKAGE_DIR}`);
console.log(`Added ${PACKAGE_SETTINGS_ENTRY} to ${SETTINGS_PATH}`);
console.log("Run /reload in pi if it is already running.");
