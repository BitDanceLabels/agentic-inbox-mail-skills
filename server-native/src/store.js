import fs from "node:fs/promises";
import path from "node:path";

export function getDataDir() {
	return process.env.MAIL_WORKER_DATA_DIR || path.resolve("server-native/data");
}

async function ensureDir(dir) {
	await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
	try {
		return JSON.parse(await fs.readFile(file, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return fallback;
		throw error;
	}
}

async function writeJson(file, data) {
	await ensureDir(path.dirname(file));
	await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

export class MailWorkerStore {
	constructor(dataDir = getDataDir()) {
		this.dataDir = dataDir;
		this.seenFile = path.join(dataDir, "seen.json");
		this.workItemsFile = path.join(dataDir, "work-items.json");
		this.outboxFile = path.join(dataDir, "outbox.json");
	}

	async hasSeen(key) {
		const seen = await readJson(this.seenFile, {});
		return Boolean(seen[key]);
	}

	async markSeen(key) {
		const seen = await readJson(this.seenFile, {});
		seen[key] = new Date().toISOString();
		await writeJson(this.seenFile, seen);
	}

	async addWorkItem(item) {
		const items = await readJson(this.workItemsFile, []);
		items.push(item);
		await writeJson(this.workItemsFile, items);
		return item;
	}

	async addOutbox(entry) {
		const outbox = await readJson(this.outboxFile, []);
		outbox.push(entry);
		await writeJson(this.outboxFile, outbox);
		return entry;
	}

	async listWorkItems() {
		return readJson(this.workItemsFile, []);
	}

	async listOutbox() {
		return readJson(this.outboxFile, []);
	}
}

