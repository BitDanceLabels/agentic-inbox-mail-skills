import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { createAdminServer } from "../src/admin-server.js";

async function withServer(fn) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bumbee-mail-admin-"));
	const oldEnv = {
		MAIL_WORKER_DATA_DIR: process.env.MAIL_WORKER_DATA_DIR,
		MAIL_WORKER_REQUIRE_AUTH: process.env.MAIL_WORKER_REQUIRE_AUTH,
		MAIL_WORKER_ADMIN_EMAILS: process.env.MAIL_WORKER_ADMIN_EMAILS,
		MAIL_WORKER_AUTH_DELIVERY: process.env.MAIL_WORKER_AUTH_DELIVERY,
		MAIL_WORKER_AUTH_TEST_CODE: process.env.MAIL_WORKER_AUTH_TEST_CODE,
	};
	process.env.MAIL_WORKER_DATA_DIR = dir;
	const server = createAdminServer();
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	try {
		await fn(`http://${address.address}:${address.port}`, dir);
	} finally {
		await new Promise((resolve) => server.close(resolve));
		for (const [key, value] of Object.entries(oldEnv)) {
			if (value == null) delete process.env[key];
			else process.env[key] = value;
		}
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

test("admin server supports email code login", async () => {
	await withServer(async (baseUrl) => {
		process.env.MAIL_WORKER_REQUIRE_AUTH = "true";
		process.env.MAIL_WORKER_ADMIN_EMAILS = "nhutpham@bitdancegroup.com";
		process.env.MAIL_WORKER_AUTH_DELIVERY = "console";
		process.env.MAIL_WORKER_AUTH_TEST_CODE = "123456";

		const blocked = await fetch(`${baseUrl}/api/state`);
		assert.equal(blocked.status, 401);

		const request = await fetch(`${baseUrl}/api/auth/request-code`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "nhutpham@bitdancegroup.com" }),
		}).then((res) => res.json());
		assert.equal(request.ok, true);

		const verify = await fetch(`${baseUrl}/api/auth/verify`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: "nhutpham@bitdancegroup.com",
				code: "123456",
			}),
		});
		assert.equal(verify.status, 200);
		const cookie = verify.headers.get("set-cookie");
		assert.match(cookie, /bumbee_mail_admin_session=/);

		const state = await fetch(`${baseUrl}/api/state`, {
			headers: { Cookie: cookie },
		});
		assert.equal(state.status, 200);
	});
});

test("admin server exposes server-native inbox and agent APIs", async () => {
	await withServer(async (baseUrl) => {
		const mailboxes = await fetch(`${baseUrl}/api/inbox/mailboxes`).then((res) => res.json());
		assert.equal(mailboxes.ok, true);
		assert.equal(mailboxes.mailboxes.length >= 1, true);

		const mailboxId = mailboxes.mailboxes[0].id;
		const emails = await fetch(`${baseUrl}/api/inbox/${encodeURIComponent(mailboxId)}/emails`).then((res) => res.json());
		assert.equal(emails.ok, true);
		assert.equal(emails.emails.length, 2);

		const agent = await fetch(`${baseUrl}/api/inbox/${encodeURIComponent(mailboxId)}/agent`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "Show me the latest inbox emails" }),
		}).then((res) => res.json());
		assert.equal(agent.ok, true);
		assert.match(agent.reply, /Latest emails/);
	});
});
