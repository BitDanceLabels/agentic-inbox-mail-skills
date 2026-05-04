import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyWorkItemSubject } from "../src/classify.js";
import { MailWorkerStore } from "../src/store.js";
import { runOnce } from "../src/worker.js";

test("classifies ticket and task subjects case-insensitively", () => {
	assert.equal(classifyWorkItemSubject("[ticket] checkout issue").type, "ticket");
	assert.equal(classifyWorkItemSubject("[TASK] weekly report").type, "task");
	assert.equal(classifyWorkItemSubject("Ticket: loi thanh toan").type, "ticket");
	assert.equal(classifyWorkItemSubject("normal email"), null);
});

test("mock worker creates work items and replies when auto-send is enabled", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bumbee-mail-worker-"));
	const store = new MailWorkerStore(dir);
	const config = {
		autoSend: true,
		mailboxes: [
			{
				id: "support@bumbee.asia",
				provider: "mock",
				messages: [
					{
						id: "m1",
						subject: "[ticket] Website broken",
						from: "client@example.com",
						bodyText: "Please fix the contact form.",
						threadId: "t1",
					},
					{
						id: "m2",
						subject: "[TASK] Prepare offer",
						from: "boss@example.com",
						bodyText: "Prepare the sales offer for tomorrow.",
						threadId: "t2",
					},
				],
			},
		],
	};
	const results = await runOnce(config, store);
	assert.equal(results.length, 2);
	const items = await store.listWorkItems();
	const outbox = await store.listOutbox();
	assert.equal(items.length, 2);
	assert.equal(outbox.length, 2);
	assert.deepEqual(items.map((item) => item.type).sort(), ["task", "ticket"]);
	assert.equal(outbox[0].subject.startsWith("Re:"), true);
});

