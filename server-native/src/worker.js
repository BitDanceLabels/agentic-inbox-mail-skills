#!/usr/bin/env node
import { classifyWorkItemSubject, buildWorkItemId } from "./classify.js";
import { generateReply } from "./ai.js";
import { MailWorkerStore } from "./store.js";
import { createProvider } from "./providers/index.js";

function parseArgs() {
	const args = new Set(process.argv.slice(2));
	return {
		once: args.has("--once"),
		mock: args.has("--mock"),
	};
}

function loadConfig({ mock = false } = {}) {
	if (mock) {
		return {
			mailboxes: [
				{ id: "support@bumbee.asia", provider: "mock" },
			],
		};
	}
	if (!process.env.MAIL_WORKER_CONFIG_JSON) {
		throw new Error("MAIL_WORKER_CONFIG_JSON is required unless --mock is used");
	}
	const config = JSON.parse(process.env.MAIL_WORKER_CONFIG_JSON);
	if (!Array.isArray(config.mailboxes) || config.mailboxes.length === 0) {
		throw new Error("MAIL_WORKER_CONFIG_JSON.mailboxes must be a non-empty array");
	}
	return config;
}

function shouldAutoSend(config) {
	const value = config.autoSend ?? process.env.MAIL_WORKER_AUTO_SEND;
	return String(value || "false").toLowerCase() === "true";
}

export async function processMailbox({ mailbox, store, autoSend }) {
	const provider = createProvider(mailbox, store);
	const messages = await provider.listMessages();
	const results = [];
	for (const message of messages) {
		const seenKey = `${mailbox.id}:${message.id}`;
		if (await store.hasSeen(seenKey)) continue;
		const classification = classifyWorkItemSubject(message.subject);
		if (!classification) {
			await store.markSeen(seenKey);
			continue;
		}
		const workItem = {
			id: buildWorkItemId(mailbox.id, message.id),
			type: classification.type,
			status: autoSend ? "auto_reply_pending" : "draft_ready",
			mailboxId: mailbox.id,
			messageId: message.id,
			threadId: message.threadId || message.id,
			from: message.from,
			subject: message.subject,
			bodyPreview: (message.bodyText || message.bodyHtml || "").slice(0, 500),
			createdAt: new Date().toISOString(),
		};
		const replyText = await generateReply({ message, classification, mailboxId: mailbox.id });
		workItem.replyText = replyText;
		let replyResult = null;
		if (autoSend) {
			replyResult = await provider.reply(message, replyText);
			workItem.status = "auto_replied";
			workItem.replyResult = replyResult;
		}
		await store.addWorkItem(workItem);
		await store.markSeen(seenKey);
		results.push({ workItem, replyResult });
	}
	return results;
}

export async function runOnce(config, store = new MailWorkerStore()) {
	const autoSend = shouldAutoSend(config);
	const all = [];
	for (const mailbox of config.mailboxes) {
		const results = await processMailbox({ mailbox, store, autoSend });
		all.push(...results);
	}
	return all;
}

async function main() {
	const args = parseArgs();
	const config = loadConfig(args);
	const pollMs = Number(process.env.MAIL_WORKER_POLL_MS || config.pollMs || 120000);
	const store = new MailWorkerStore();
	const tick = async () => {
		const results = await runOnce(config, store);
		console.log(JSON.stringify({
			at: new Date().toISOString(),
			processed: results.length,
			autoSend: shouldAutoSend(config),
		}));
	};
	await tick();
	if (args.once) return;
	setInterval(() => {
		tick().catch((error) => console.error("mail worker tick failed", error));
	}, pollMs);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

