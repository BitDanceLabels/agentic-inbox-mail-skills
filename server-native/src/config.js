import fs from "node:fs/promises";
import path from "node:path";
import { getDataDir } from "./store.js";

export function getConfigFile() {
	return process.env.MAIL_WORKER_CONFIG_FILE || path.join(getDataDir(), "config.json");
}

export function getMockConfig() {
	const stamp = Date.now();
	return {
		autoSend: true,
		pollMs: 120000,
		mailboxes: [
			{
				id: "support@bumbee.asia",
				provider: "mock",
				messages: [
					{
						id: `demo-ticket-${stamp}`,
						subject: "[ticket] Website contact form needs support",
						from: "customer@example.com",
						bodyText: "The contact form did not submit. Please check and confirm the next step.",
						threadId: `thread-ticket-${stamp}`,
					},
					{
						id: `demo-task-${stamp}`,
						subject: "[TASK] Prepare customer follow-up",
						from: "ops@example.com",
						bodyText: "Prepare a short customer follow-up and assign the next owner.",
						threadId: `thread-task-${stamp}`,
					},
				],
			},
		],
	};
}

export function validateConfig(config) {
	if (!config || typeof config !== "object") {
		throw new Error("Config must be a JSON object");
	}
	if (!Array.isArray(config.mailboxes) || config.mailboxes.length === 0) {
		throw new Error("config.mailboxes must be a non-empty array");
	}
	for (const mailbox of config.mailboxes) {
		if (!mailbox.id || typeof mailbox.id !== "string") {
			throw new Error("Each mailbox requires an id");
		}
		if (!mailbox.provider || typeof mailbox.provider !== "string") {
			throw new Error(`Mailbox ${mailbox.id} requires a provider`);
		}
	}
	return config;
}

export async function readSavedConfig(configFile = getConfigFile()) {
	const raw = await fs.readFile(configFile, "utf8");
	return validateConfig(JSON.parse(raw));
}

export async function writeSavedConfig(config, configFile = getConfigFile()) {
	validateConfig(config);
	await fs.mkdir(path.dirname(configFile), { recursive: true });
	await fs.writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return config;
}

export function redactConfig(config) {
	const secretKeys = new Set([
		"accessToken",
		"refreshToken",
		"clientSecret",
		"aiToken",
		"token",
	]);
	const redact = (value) => {
		if (Array.isArray(value)) return value.map(redact);
		if (!value || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, entry]) => [
				key,
				secretKeys.has(key) && entry ? "********" : redact(entry),
			]),
		);
	};
	return redact(config);
}
