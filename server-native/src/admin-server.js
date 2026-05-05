#!/usr/bin/env node
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import {
	getConfigFile,
	getMockConfig,
	readSavedConfig,
	redactConfig,
	writeSavedConfig,
} from "./config.js";
import { MailWorkerStore, getDataDir } from "./store.js";
import { runOnce } from "./worker.js";
import { generateReply } from "./ai.js";

const otpCodes = new Map();
const sessions = new Map();
const OTP_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function sendJson(res, status, body) {
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(body, null, 2));
}

async function readBody(req) {
	const chunks = [];
	for await (const chunk of req) chunks.push(chunk);
	if (chunks.length === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseCookies(req) {
	const header = req.headers.cookie || "";
	return Object.fromEntries(
		header.split(";").map((part) => {
			const [key, ...rest] = part.trim().split("=");
			return [key, decodeURIComponent(rest.join("=") || "")];
		}).filter(([key]) => key),
	);
}

function setSessionCookie(res, token) {
	res.setHeader(
		"Set-Cookie",
		`bumbee_mail_admin_session=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
	);
}

function clearSessionCookie(res) {
	res.setHeader(
		"Set-Cookie",
		"bumbee_mail_admin_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0",
	);
}

function getAllowedEmails() {
	return (process.env.MAIL_WORKER_ADMIN_EMAILS || "nhutpham@bitdancegroup.com")
		.split(",")
		.map((email) => email.trim().toLowerCase())
		.filter(Boolean);
}

function isAllowedEmail(email) {
	return getAllowedEmails().includes(String(email || "").trim().toLowerCase());
}

function createOtpCode() {
	return process.env.MAIL_WORKER_AUTH_TEST_CODE || String(randomInt(100000, 999999));
}

async function sendCodeEmail(email, code) {
	const from = process.env.MAIL_WORKER_AUTH_FROM || "nhutpham@bitdancegroup.com";
	const subject = "Bumbee Mail Center login code";
	const body = [
		"Your Bumbee Mail Center login code:",
		"",
		code,
		"",
		"This code expires in 10 minutes.",
	].join("\n");
	if ((process.env.MAIL_WORKER_AUTH_DELIVERY || "").toLowerCase() === "console") {
		console.log(`Bumbee Mail Center code for ${email}: ${code}`);
		return { delivery: "console" };
	}
	const gatewayUrl = process.env.MAIL_WORKER_AUTH_GATEWAY_URL || "";
	if (gatewayUrl) {
		const res = await fetch(gatewayUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				to_email: email,
				subject,
				message: body,
				profile: process.env.MAIL_WORKER_AUTH_GATEWAY_PROFILE || "gmail_work",
			}),
		});
		if (!res.ok) {
			const detail = await res.text().catch(() => "");
			throw new Error(`mail gateway returned HTTP ${res.status}: ${detail.slice(0, 300)}`);
		}
		return { delivery: "mail-gateway" };
	}
	const message = [
		`From: Bumbee Mail Center <${from}>`,
		`To: ${email}`,
		`Subject: ${subject}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"",
		body,
	].join("\n");
	await new Promise((resolve, reject) => {
		const child = spawn("/usr/sbin/sendmail", ["-f", from, "-t"], { stdio: ["pipe", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(stderr || `sendmail exited with ${code}`));
		});
		child.stdin.end(message);
	});
	return { delivery: "sendmail" };
}

function getSession(req) {
	const token = parseCookies(req).bumbee_mail_admin_session;
	if (!token) return null;
	const session = sessions.get(token);
	if (!session || session.expiresAt < Date.now()) {
		sessions.delete(token);
		return null;
	}
	return session;
}

async function getState() {
	const store = new MailWorkerStore();
	let config = null;
	let configError = null;
	try {
		config = await readSavedConfig();
	} catch (error) {
		configError = error.code === "ENOENT" ? "No saved config yet" : error.message;
	}
	const [workItems, outbox] = await Promise.all([
		store.listWorkItems(),
		store.listOutbox(),
	]);
	return {
		ok: true,
		dataDir: getDataDir(),
		configFile: getConfigFile(),
		config: config ? redactConfig(config) : null,
		configText: config ? JSON.stringify(config, null, 2) : JSON.stringify(getMockConfig(), null, 2),
		configError,
		workItems: workItems.slice(-50).reverse(),
		outbox: outbox.slice(-50).reverse(),
	};
}

function getDefaultMailboxes() {
	return [
		"support@bumbee.asia",
		"nhutpham@bitdancegroup.com",
		"bitdance.work@gmail.com",
	];
}

async function getInboxMailboxes() {
	try {
		const config = await readSavedConfig();
		const ids = config.mailboxes.map((mailbox) => mailbox.id).filter(Boolean);
		return ids.length ? ids : getDefaultMailboxes();
	} catch {
		return getDefaultMailboxes();
	}
}

function inboxFile(mailboxId) {
	return `${getDataDir()}/inbox-${mailboxId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

async function readInbox(mailboxId) {
	const fs = await import("node:fs/promises");
	try {
		return JSON.parse(await fs.readFile(inboxFile(mailboxId), "utf8"));
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
		const now = new Date().toISOString();
		const seeded = [
			{
				id: "welcome-ticket",
				folder: "inbox",
				subject: "[ticket] Demo customer support request",
				sender: "customer@example.com",
				recipient: mailboxId,
				date: now,
				read: false,
				starred: false,
				body: "Customer reports that the contact form needs a follow-up. Use the AI Agent to summarize, classify, and draft the next reply.",
				thread_id: "welcome-ticket",
			},
			{
				id: "welcome-task",
				folder: "inbox",
				subject: "[task] Prepare operations checklist",
				sender: "ops@example.com",
				recipient: mailboxId,
				date: now,
				read: true,
				starred: false,
				body: "Prepare a short checklist for handling ticket and task emails from this mailbox.",
				thread_id: "welcome-task",
			},
		];
		await fs.mkdir(getDataDir(), { recursive: true });
		await fs.writeFile(inboxFile(mailboxId), `${JSON.stringify(seeded, null, 2)}\n`, "utf8");
		return seeded;
	}
}

async function writeInbox(mailboxId, emails) {
	const fs = await import("node:fs/promises");
	await fs.mkdir(getDataDir(), { recursive: true });
	await fs.writeFile(inboxFile(mailboxId), `${JSON.stringify(emails, null, 2)}\n`, "utf8");
}

function extractTextFromAiResponse(data) {
	return (
		data?.reply ||
		data?.answer ||
		data?.text ||
		data?.message ||
		data?.choices?.[0]?.message?.content ||
		data?.choices?.[0]?.text ||
		null
	);
}

async function callOpenAiCompatible({ mailboxId, message, emails, selectedEmail }) {
	const baseUrl = process.env.MAIL_WORKER_AI_BASE_URL || process.env.BUMBEE_MAIL_AI_BASE_URL || "";
	const apiKey = process.env.MAIL_WORKER_AI_API_KEY || process.env.BUMBEE_MAIL_AI_API_KEY || "";
	const model = process.env.MAIL_WORKER_AI_MODEL || process.env.BUMBEE_MAIL_AI_MODEL || "gpt-4o-mini";
	if (!baseUrl || !apiKey) return null;
	const mailboxSnapshot = emails.slice(0, 8).map((email) => ({
		subject: email.subject,
		from: email.sender,
		to: email.recipient,
		date: email.date,
		read: email.read,
		preview: String(email.body || "").slice(0, 500),
	}));
	const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			temperature: 0.4,
			messages: [
				{
					role: "system",
					content: [
						"You are Bumbee Email Agent, a practical Vietnamese/English email operations assistant.",
						"Answer naturally and directly. Help read inboxes, classify ticket/task emails, summarize, and draft professional replies.",
						"If the user asks what model you use, say the configured model id and that you are routed through the Bumbee server-native mail center.",
					].join(" "),
				},
				{
					role: "user",
					content: JSON.stringify({
						mailboxId,
						selectedEmail,
						inbox: mailboxSnapshot,
						userMessage: message,
					}),
				},
			],
		}),
	});
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`AI gateway HTTP ${res.status}: ${detail.slice(0, 300)}`);
	}
	const data = await res.json();
	return extractTextFromAiResponse(data);
}

async function agentReply({ mailboxId, message, emailId }) {
	const emails = await readInbox(mailboxId);
	const selectedEmail = emails.find((email) => email.id === emailId) || emails[0] || null;
	const latest = emails.slice(0, 5).map((email) => `- ${email.subject} from ${email.sender}`).join("\n");
	const lower = message.toLowerCase();
	try {
		const aiText = await callOpenAiCompatible({ mailboxId, message, emails, selectedEmail });
		if (aiText) return `${aiText}\n\nSource: ${process.env.MAIL_WORKER_AI_MODEL || process.env.BUMBEE_MAIL_AI_MODEL || "configured AI model"}`;
	} catch (error) {
		console.error("mail agent AI gateway failed", error.message);
	}
	if (lower.includes("model") || lower.includes("models") || lower.includes("mô hình") || lower.includes("mo hinh")) {
		return [
			"Hiện tại Mail Center đang chạy ở chế độ server-native fallback.",
			"",
			"Model thật sẽ được dùng khi cấu hình các biến:",
			"- MAIL_WORKER_AI_BASE_URL",
			"- MAIL_WORKER_AI_API_KEY",
			"- MAIL_WORKER_AI_MODEL",
			"",
			"UI và agent API đã sẵn sàng để nối vào OpenAI-compatible gateway của Bumbee. Nếu gateway token/model đang sống, em sẽ trả lời bằng model thật thay vì fallback này.",
		].join("\n");
	}
	if (lower.includes("xin chào") || lower.includes("chào") || lower.includes("hello") || lower.includes("hi ")) {
		return `Chào anh. Em là Bumbee Email Agent của mailbox ${mailboxId}. Em có thể đọc email đang chọn, liệt kê mail mới, tìm mail chưa đọc, phân loại ticket/task và soạn nháp trả lời.`;
	}
	if (lower.includes("latest") || lower.includes("unread") || lower.includes("inbox")) {
		return `Latest emails in ${mailboxId}:\n${latest || "No emails yet."}`;
	}
	if (lower.includes("summarize") || lower.includes("tóm tắt") || lower.includes("tom tat")) {
		if (!selectedEmail) return "Chưa có email nào để tóm tắt.";
		return [
			`Tóm tắt email đang chọn: ${selectedEmail.subject}`,
			`Người gửi: ${selectedEmail.sender}`,
			"",
			String(selectedEmail.body || "").slice(0, 800),
			"",
			selectedEmail.subject.toLowerCase().includes("ticket") ? "Phân loại: ticket cần xử lý/response." : "Phân loại: task hoặc email vận hành.",
		].join("\n");
	}
	if (lower.includes("draft") || lower.includes("reply")) {
		const email = selectedEmail || emails[0];
		return generateReply({
			message: {
				subject: email?.subject || "Email reply",
				from: email?.sender || "",
				bodyText: email?.body || "",
			},
			classification: { type: email?.subject?.toLowerCase().includes("task") ? "task" : "ticket" },
			mailboxId,
		});
	}
	return [
		`Em đang xem mailbox ${mailboxId}.`,
		"",
		"Em có thể xử lý các lệnh:",
		"- Show me the latest inbox emails",
		"- Any unread emails?",
		"- Tóm tắt email này",
		"- Draft a response",
		"- Bạn đang dùng model gì?",
		"",
		`Snapshot:\n${latest || "No emails yet."}`,
	].join("\n");
}

function getAdminToken() {
	return process.env.MAIL_WORKER_ADMIN_TOKEN || "";
}

function isAuthorized(req, url) {
	const requireAuth = String(process.env.MAIL_WORKER_REQUIRE_AUTH || "").toLowerCase() === "true" || Boolean(getAdminToken());
	if (!requireAuth) return true;
	if (getSession(req)) return true;
	const token = getAdminToken();
	const auth = req.headers.authorization || "";
	const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
	const headerToken = req.headers["x-admin-token"] || "";
	const queryToken = url.searchParams.get("token") || "";
	if (!token) return false;
	return [bearer, headerToken, queryToken].some((candidate) => candidate === token);
}

function html() {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Bumbee Mail Worker Admin</title>
	<style>
		:root { color-scheme: light; --bg:#f6f7f9; --panel:#fff; --text:#111827; --muted:#6b7280; --line:#dfe3ea; --accent:#f4b000; --dark:#1f2937; --good:#087f5b; --bad:#b42318; }
		* { box-sizing: border-box; }
		body { margin:0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
		header { border-bottom:1px solid var(--line); background:var(--panel); }
		.wrap { max-width:1180px; margin:0 auto; padding:24px; }
		.top { display:flex; align-items:center; justify-content:space-between; gap:16px; }
		h1 { margin:0; font-size:24px; line-height:1.2; }
		h2, h3 { margin:8px 0 10px; }
		p { color:var(--muted); line-height:1.55; }
		.grid { display:grid; grid-template-columns:minmax(0, 1.2fr) minmax(320px, .8fr); gap:18px; align-items:start; }
		.panel { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:18px; }
		.actions { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:14px 0; }
		button { border:1px solid var(--dark); border-radius:7px; padding:10px 13px; background:var(--dark); color:#fff; font-weight:650; cursor:pointer; }
		button.secondary { background:#fff; color:var(--dark); border-color:var(--line); }
		button.warn { background:var(--accent); color:#111; border-color:#d49800; }
		textarea { width:100%; min-height:430px; resize:vertical; font:13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding:12px; border:1px solid var(--line); border-radius:8px; color:var(--text); background:#fbfcfe; }
		code { background:#eef1f5; padding:2px 5px; border-radius:4px; overflow-wrap:anywhere; }
		.status { min-height:24px; font-size:14px; color:var(--muted); }
		.status.good { color:var(--good); }
		.status.bad { color:var(--bad); }
		.item { border-top:1px solid var(--line); padding:12px 0; }
		.item:first-child { border-top:0; }
		.kicker { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; font-weight:700; }
		.subject { margin-top:4px; font-weight:700; }
		.preview { color:var(--muted); font-size:14px; margin-top:4px; white-space:pre-wrap; overflow-wrap:anywhere; }
		.badge { display:inline-flex; border-radius:999px; padding:2px 8px; font-size:12px; font-weight:700; background:#eef1f5; color:#374151; }
		.row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
		@media (max-width: 860px) { .grid { grid-template-columns:1fr; } .top { align-items:flex-start; flex-direction:column; } }
	</style>
</head>
<body>
	<header>
		<div class="wrap top">
			<div>
				<h1>Bumbee Mail Worker Admin</h1>
				<p>Quan tri worker nhan dien <code>[ticket]</code> va <code>[task]</code>, tao work item, goi AI, roi reply tren cung luong mail.</p>
			</div>
			<button class="secondary" onclick="loadState()">Refresh</button>
		</div>
	</header>
	<main class="wrap grid">
		<section class="panel" id="login-panel" hidden>
			<div class="kicker">Admin access</div>
			<h2>Login by email code</h2>
			<p>Nhap email duoc cap quyen, nhan code 6 so qua mail, roi verify de vao trang quan tri.</p>
			<input id="email-input" style="width:100%;padding:12px;border:1px solid var(--line);border-radius:8px" value="nhutpham@bitdancegroup.com" />
			<input id="code-input" style="width:100%;padding:12px;border:1px solid var(--line);border-radius:8px;margin-top:10px" placeholder="6-digit code" />
			<div class="actions">
				<button onclick="requestCode()">Get code</button>
				<button class="warn" onclick="verifyCode()">Verify</button>
			</div>
			<div id="login-status" class="status"></div>
		</section>
		<section class="panel" id="config-panel">
			<div class="row">
				<div>
					<div class="kicker">Configuration</div>
					<h2>Mailboxes JSON</h2>
				</div>
				<span class="badge" id="config-state">Loading</span>
			</div>
			<p>Luu config o server de <code>npm run mail:worker</code> doc truc tiep. Token that chi luu local tren server, phan trang thai se duoc che.</p>
			<textarea id="config"></textarea>
			<div class="actions">
				<button onclick="saveConfig()">Save config</button>
				<button class="warn" onclick="runOnce(false)">Run once</button>
				<button class="secondary" onclick="runOnce(true)">Run demo mock</button>
			</div>
			<div id="status" class="status"></div>
		</section>
		<aside class="panel">
			<div class="kicker">Runtime</div>
			<p><strong>Data dir:</strong> <code id="data-dir"></code></p>
			<p><strong>Config file:</strong> <code id="config-file"></code></p>
			<h3>Latest work items</h3>
			<div id="work-items"></div>
			<h3>Latest outbox replies</h3>
			<div id="outbox"></div>
		</aside>
	</main>
	<script>
		const statusEl = document.getElementById("status");
		const configEl = document.getElementById("config");
		const loginPanel = document.getElementById("login-panel");
		const configPanel = document.getElementById("config-panel");
		const emailInput = document.getElementById("email-input");
		const codeInput = document.getElementById("code-input");
		const loginStatus = document.getElementById("login-status");
		let adminToken = localStorage.getItem("bumbeeMailAdminToken") || new URLSearchParams(location.search).get("token") || "";
		if (adminToken) localStorage.setItem("bumbeeMailAdminToken", adminToken);
		function setStatus(text, kind = "") {
			statusEl.textContent = text;
			statusEl.className = "status " + kind;
		}
		function showLogin(message) {
			loginPanel.hidden = false;
			configPanel.hidden = true;
			loginStatus.textContent = message || "Admin token required.";
			loginStatus.className = "status bad";
		}
		async function requestCode() {
			try {
				const result = await api("/api/auth/request-code", { method: "POST", body: JSON.stringify({ email: emailInput.value.trim() }) });
				loginStatus.textContent = "Code sent to " + result.email + ".";
				loginStatus.className = "status good";
			} catch (error) {
				showLogin(error.message);
			}
		}
		async function verifyCode() {
			try {
				await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ email: emailInput.value.trim(), code: codeInput.value.trim() }) });
				loginStatus.textContent = "Login successful.";
				loginStatus.className = "status good";
				await loadState();
			} catch (error) {
				showLogin(error.message);
			}
		}
		async function api(path, options) {
			const res = await fetch(path, {
				...options,
				headers: {
					"Content-Type": "application/json",
					...(adminToken ? { Authorization: "Bearer " + adminToken } : {}),
					...(options && options.headers ? options.headers : {}),
				},
			});
			const data = await res.json();
			if (res.status === 401) {
				showLogin(data.error || "Admin token required.");
			}
			if (!res.ok) throw new Error(data.error || "Request failed");
			return data;
		}
		function escapeHtml(value) {
			return String(value).replace(/[&<>"']/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[char]));
		}
		function renderList(id, rows, empty) {
			const el = document.getElementById(id);
			el.innerHTML = rows.length ? rows.map((row) => '<div class="item"><div class="kicker">' +
				escapeHtml((row.type || row.mailboxId || "reply") + ' · ' + (row.status || row.createdAt || row.sentAt || "")) +
				'</div><div class="subject">' + escapeHtml(row.subject || "") + '</div><div class="preview">' +
				escapeHtml(row.replyText || row.bodyPreview || row.bodyText || "") + '</div></div>').join("") : '<p>' + empty + '</p>';
		}
		async function loadState() {
			const state = await api("/api/state");
			loginPanel.hidden = true;
			configPanel.hidden = false;
			document.getElementById("data-dir").textContent = state.dataDir;
			document.getElementById("config-file").textContent = state.configFile;
			document.getElementById("config-state").textContent = state.configError ? "Needs config" : "Configured";
			configEl.value = state.configText;
			renderList("work-items", state.workItems, "No tickets or tasks yet.");
			renderList("outbox", state.outbox, "No replies yet.");
			setStatus(state.configError || "Ready", state.configError ? "" : "good");
		}
		async function saveConfig() {
			try {
				const config = JSON.parse(configEl.value);
				await api("/api/config", { method: "POST", body: JSON.stringify({ config }) });
				setStatus("Saved config successfully.", "good");
				await loadState();
			} catch (error) {
				setStatus(error.message, "bad");
			}
		}
		async function runOnce(mock) {
			try {
				const result = await api("/api/run-once", { method: "POST", body: JSON.stringify({ mock }) });
				setStatus("Processed " + result.processed + " message(s).", "good");
				await loadState();
			} catch (error) {
				setStatus(error.message, "bad");
			}
		}
		loadState().catch((error) => setStatus(error.message, "bad"));
	</script>
</body>
</html>`;
}

function inboxHtml() {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Bumbee Mail Center Inbox</title>
	<style>
		:root { --bg:#f5f6f8; --panel:#fff; --line:#dfe3ea; --text:#111827; --muted:#6b7280; --brand:#f4b000; --dark:#1f2937; }
		* { box-sizing:border-box; }
		body { margin:0; font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color:var(--text); background:var(--bg); }
		.shell { display:grid; grid-template-columns:250px minmax(320px, 430px) minmax(420px, 1fr) 380px; height:100vh; overflow:hidden; }
		aside, section { border-right:1px solid var(--line); background:var(--panel); min-width:0; }
		.brand { padding:18px; border-bottom:1px solid var(--line); }
		.brand h1 { margin:0; font-size:18px; }
		.brand p { margin:6px 0 0; color:var(--muted); font-size:13px; line-height:1.45; }
		.nav { padding:10px; }
		button { border:1px solid var(--line); background:#fff; color:var(--text); border-radius:7px; padding:9px 11px; cursor:pointer; font-weight:650; }
		button.primary { background:var(--dark); color:#fff; border-color:var(--dark); }
		.mailbox, .email { width:100%; text-align:left; display:block; margin:4px 0; }
		.mailbox.active, .email.active { background:#fff7db; border-color:#e0aa00; }
		.toolbar { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:12px; border-bottom:1px solid var(--line); }
		.list { overflow:auto; height:calc(100vh - 57px); padding:8px; }
		.email { padding:12px; }
		.email strong { display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
		.email span { display:block; color:var(--muted); font-size:12px; margin-top:3px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
		.reader { display:flex; flex-direction:column; height:100vh; background:#fff; }
		.reader-head { padding:18px 22px; border-bottom:1px solid var(--line); }
		.reader-head h2 { margin:0 0 8px; font-size:22px; }
		.meta { color:var(--muted); font-size:13px; }
		.body { padding:22px; line-height:1.65; white-space:pre-wrap; overflow:auto; }
		.agent { display:flex; flex-direction:column; height:100vh; background:#fff; }
		.agent-head { padding:13px; border-bottom:1px solid var(--line); display:flex; align-items:center; gap:8px; }
		.badge { background:#fff1b8; color:#5b4200; padding:3px 7px; border-radius:999px; font-size:12px; font-weight:800; }
		.chat { flex:1; overflow:auto; padding:14px; display:flex; flex-direction:column; gap:10px; }
		.msg { border:1px solid var(--line); border-radius:8px; padding:10px; line-height:1.45; white-space:pre-wrap; font-size:14px; }
		.msg.user { align-self:flex-end; background:#1f2937; color:#fff; max-width:88%; }
		.msg.ai { align-self:flex-start; background:#fbfcfe; max-width:92%; }
		.agent-input { display:flex; gap:8px; padding:12px; border-top:1px solid var(--line); }
		textarea { flex:1; min-height:42px; max-height:110px; resize:vertical; border:1px solid var(--line); border-radius:8px; padding:10px; font:14px/1.4 inherit; }
		.login { max-width:460px; margin:80px auto; background:#fff; border:1px solid var(--line); border-radius:8px; padding:22px; }
		input { width:100%; padding:11px; border:1px solid var(--line); border-radius:8px; margin:8px 0; }
		@media (max-width: 1180px) { .shell { grid-template-columns:220px 360px 1fr; } .agent { display:none; } }
		@media (max-width: 780px) { .shell { grid-template-columns:1fr; } aside, .reader { display:none; } .agent { display:flex; } }
	</style>
</head>
<body>
	<div id="login" class="login" hidden>
		<h1>Bumbee Mail Center</h1>
		<p>Login bang email code de mo inbox va AI Agent.</p>
		<input id="login-email" value="nhutpham@bitdancegroup.com" />
		<input id="login-code" placeholder="6-digit code" />
		<button class="primary" onclick="requestCode()">Get code</button>
		<button onclick="verifyCode()">Verify</button>
		<p id="login-msg"></p>
	</div>
	<div id="app" class="shell">
		<aside>
			<div class="brand">
				<h1>Bumbee Inbox</h1>
				<p>Server-native mail UI with AI Agent. No Cloudflare Worker runtime.</p>
			</div>
			<div class="nav" id="mailboxes"></div>
			<div class="nav"><a href="/"><button>Worker Admin</button></a></div>
		</aside>
		<section>
			<div class="toolbar"><strong>Inbox</strong><button onclick="loadEmails()">Refresh</button></div>
			<div class="list" id="emails"></div>
		</section>
		<main class="reader">
			<div class="reader-head">
				<h2 id="subject">Select an email</h2>
				<div class="meta" id="meta"></div>
			</div>
			<div class="body" id="body">Choose a message from the inbox list.</div>
		</main>
		<section class="agent">
			<div class="agent-head"><span class="badge">AI</span><strong>Email Agent</strong></div>
			<div id="chat" class="chat"></div>
			<div class="agent-input">
				<textarea id="agent-input" placeholder="Ask your email agent..."></textarea>
				<button class="primary" onclick="sendAgent()">Send</button>
			</div>
		</section>
	</div>
	<script>
		let mailboxId = "";
		let selectedEmail = null;
		let mailboxesCache = [];
		let readyShown = false;
		function esc(value) { return String(value || "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" }[c])); }
		async function api(path, options) {
			const res = await fetch(path, { headers:{ "Content-Type":"application/json" }, ...options });
			const data = await res.json();
			if (res.status === 401) { document.getElementById("login").hidden = false; document.getElementById("app").hidden = true; throw new Error(data.error || "Login required"); }
			if (!res.ok) throw new Error(data.error || "Request failed");
			return data;
		}
		async function requestCode() {
			const email = document.getElementById("login-email").value.trim();
			const result = await api("/api/auth/request-code", { method:"POST", body:JSON.stringify({ email }) }).catch((e) => ({ error:e.message }));
			document.getElementById("login-msg").textContent = result.error || "Code sent to " + result.email;
		}
		async function verifyCode() {
			const email = document.getElementById("login-email").value.trim();
			const code = document.getElementById("login-code").value.trim();
			await api("/api/auth/verify", { method:"POST", body:JSON.stringify({ email, code }) });
			document.getElementById("login").hidden = true; document.getElementById("app").hidden = false; init();
		}
		function renderMailboxes() {
			document.getElementById("mailboxes").innerHTML = mailboxesCache.map((m) => '<button class="mailbox ' + (m.id === mailboxId ? 'active' : '') + '" onclick="selectMailbox(\\'' + esc(m.id) + '\\')">' + esc(m.id) + '</button>').join("");
		}
		async function init(preferredMailbox) {
			const data = await api("/api/inbox/mailboxes");
			mailboxesCache = data.mailboxes || [];
			mailboxId = preferredMailbox || mailboxId || mailboxesCache[0]?.id || "";
			renderMailboxes();
			await loadEmails();
			if (!readyShown) {
				readyShown = true;
				addAi("Ready. Try: Show me the latest inbox emails, Any unread emails, Tóm tắt email này, or Draft a response.");
			}
		}
		async function selectMailbox(id) {
			if (mailboxId === id) return;
			mailboxId = id;
			selectedEmail = null;
			renderMailboxes();
			document.getElementById("subject").textContent = "Loading...";
			document.getElementById("meta").textContent = mailboxId;
			document.getElementById("body").textContent = "";
			document.getElementById("chat").innerHTML = "";
			addAi("Switched to " + mailboxId + ". Ask me to list latest emails, summarize the selected email, or draft a reply.");
			await loadEmails();
		}
		async function loadEmails() {
			const data = await api("/api/inbox/" + encodeURIComponent(mailboxId) + "/emails");
			document.getElementById("emails").innerHTML = data.emails.map((e, i) => '<button class="email ' + (selectedEmail?.id === e.id || (!selectedEmail && i === 0) ? 'active' : '') + '" onclick="openEmail(\\'' + esc(e.id) + '\\')"><strong>' + esc(e.subject) + '</strong><span>' + esc(e.sender) + ' · ' + esc(e.date) + '</span><span>' + esc(e.body).slice(0, 120) + '</span></button>').join("");
			if (!selectedEmail && data.emails[0]) openEmail(data.emails[0].id, data.emails);
		}
		async function openEmail(id, existing) {
			const emails = existing || (await api("/api/inbox/" + encodeURIComponent(mailboxId) + "/emails")).emails;
			selectedEmail = emails.find((e) => e.id === id);
			if (!selectedEmail) return;
			document.getElementById("subject").textContent = selectedEmail.subject;
			document.getElementById("meta").textContent = selectedEmail.sender + " -> " + selectedEmail.recipient + " · " + selectedEmail.date;
			document.getElementById("body").textContent = selectedEmail.body;
		}
		function addUser(text) { document.getElementById("chat").insertAdjacentHTML("beforeend", '<div class="msg user">' + esc(text) + '</div>'); }
		function addAi(text) { document.getElementById("chat").insertAdjacentHTML("beforeend", '<div class="msg ai">' + esc(text) + '</div>'); document.getElementById("chat").scrollTop = document.getElementById("chat").scrollHeight; }
		async function sendAgent() {
			const input = document.getElementById("agent-input");
			const text = input.value.trim();
			if (!text) return;
			input.value = "";
			addUser(text);
			const pendingId = "pending-" + Date.now();
			document.getElementById("chat").insertAdjacentHTML("beforeend", '<div id="' + pendingId + '" class="msg ai">Thinking...</div>');
			try {
				const result = await api("/api/inbox/" + encodeURIComponent(mailboxId) + "/agent", { method:"POST", body:JSON.stringify({ message:text, emailId:selectedEmail?.id }) });
				document.getElementById(pendingId).textContent = result.reply;
			} catch (error) {
				document.getElementById(pendingId).textContent = "AI request failed: " + error.message;
			}
			document.getElementById("chat").scrollTop = document.getElementById("chat").scrollHeight;
		}
		init().catch((error) => console.log(error.message));
	</script>
</body>
</html>`;
}

async function handle(req, res) {
	const url = new URL(req.url, "http://localhost");
	try {
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html());
			return;
		}
		if (req.method === "GET" && url.pathname === "/inbox") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(inboxHtml());
			return;
		}
		if (req.method === "GET" && url.pathname === "/health") {
			sendJson(res, 200, { ok: true, service: "bumbee-mail-worker-admin" });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/auth/request-code") {
			const body = await readBody(req);
			const email = String(body.email || "").trim().toLowerCase();
			if (!isAllowedEmail(email)) {
				sendJson(res, 403, { error: "Email is not allowed" });
				return;
			}
			const code = createOtpCode();
			otpCodes.set(email, { code, expiresAt: Date.now() + OTP_TTL_MS });
			const delivery = await sendCodeEmail(email, code);
			sendJson(res, 200, { ok: true, email, ...delivery });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/auth/verify") {
			const body = await readBody(req);
			const email = String(body.email || "").trim().toLowerCase();
			const code = String(body.code || "").trim();
			const record = otpCodes.get(email);
			if (!isAllowedEmail(email) || !record || record.expiresAt < Date.now() || record.code !== code) {
				sendJson(res, 401, { error: "Invalid or expired code" });
				return;
			}
			otpCodes.delete(email);
			const sessionToken = randomBytes(32).toString("hex");
			sessions.set(sessionToken, { email, expiresAt: Date.now() + SESSION_TTL_MS });
			setSessionCookie(res, sessionToken);
			sendJson(res, 200, { ok: true, email });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/auth/logout") {
			const token = parseCookies(req).bumbee_mail_admin_session;
			if (token) sessions.delete(token);
			clearSessionCookie(res);
			sendJson(res, 200, { ok: true });
			return;
		}
		if (url.pathname.startsWith("/api/") && !isAuthorized(req, url)) {
			sendJson(res, 401, { error: "Login required" });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/inbox/mailboxes") {
			const mailboxes = await getInboxMailboxes();
			sendJson(res, 200, { ok: true, mailboxes: mailboxes.map((id) => ({ id, email: id, name: id.split("@")[0] })) });
			return;
		}
		const inboxEmailsMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/emails$/);
		if (req.method === "GET" && inboxEmailsMatch) {
			const mailboxId = decodeURIComponent(inboxEmailsMatch[1]);
			const emails = await readInbox(mailboxId);
			sendJson(res, 200, { ok: true, emails: emails.sort((a, b) => String(b.date).localeCompare(String(a.date))) });
			return;
		}
		const inboxAgentMatch = url.pathname.match(/^\/api\/inbox\/([^/]+)\/agent$/);
		if (req.method === "POST" && inboxAgentMatch) {
			const mailboxId = decodeURIComponent(inboxAgentMatch[1]);
			const body = await readBody(req);
			const reply = await agentReply({ mailboxId, message: String(body.message || ""), emailId: body.emailId });
			sendJson(res, 200, { ok: true, reply });
			return;
		}
		if (req.method === "GET" && url.pathname === "/api/state") {
			sendJson(res, 200, await getState());
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/config") {
			const body = await readBody(req);
			await writeSavedConfig(body.config);
			sendJson(res, 200, { ok: true, configFile: getConfigFile() });
			return;
		}
		if (req.method === "POST" && url.pathname === "/api/run-once") {
			const body = await readBody(req);
			const config = body.mock ? getMockConfig() : await readSavedConfig();
			const results = await runOnce(config, new MailWorkerStore());
			sendJson(res, 200, { ok: true, processed: results.length });
			return;
		}
		sendJson(res, 404, { error: "Not found" });
	} catch (error) {
		sendJson(res, 400, { error: error.message });
	}
}

export function createAdminServer() {
	return http.createServer((req, res) => {
		handle(req, res).catch((error) => sendJson(res, 500, { error: error.message }));
	});
}

export async function startAdminServer({
	port = Number(process.env.MAIL_WORKER_ADMIN_PORT || 18920),
	host = process.env.MAIL_WORKER_ADMIN_HOST || "127.0.0.1",
} = {}) {
	const server = createAdminServer();
	server.listen(port, host);
	await once(server, "listening");
	const address = server.address();
	console.log(`Bumbee Mail Worker Admin listening on http://${address.address}:${address.port}`);
	return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	startAdminServer().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}
