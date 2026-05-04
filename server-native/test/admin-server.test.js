import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createAdminServer } from "../src/admin-server.js";

async function withServer(fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bumbee-mail-admin-"));
	process.env.MAIL_WORKER_DATA_DIR = dir;
	const server = createAdminServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	try {
		await fn(`http://${address.address}:${address.port}`, dir);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		delete process.env.MAIL_WORKER_DATA_DIR;
	}
}

test("admin server saves config and runs mock demo", async () => {
	await withServer(async (baseUrl, dir) => {
		const health = await fetch(`${baseUrl}/health`).then((res) => res.json());
		assert.equal(health.ok, true);

		const config = {
			autoSend: true,
			mailboxes: [{ id: "support@bumbee.asia", provider: "mock", messages: [] }],
		};
		const save = await fetch(`${baseUrl}/api/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ config }),
		}).then((res) => res.json());
		assert.equal(save.ok, true);

		const run = await fetch(`${baseUrl}/api/run-once`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mock: true }),
		}).then((res) => res.json());
		assert.equal(run.processed, 2);

		const state = await fetch(`${baseUrl}/api/state`).then((res) => res.json());
		assert.equal(state.workItems.length, 2);
		assert.equal(state.outbox.length, 2);
		assert.equal(state.configFile, path.join(dir, "config.json"));
	});
});
