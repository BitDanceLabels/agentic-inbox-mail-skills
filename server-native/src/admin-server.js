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
		const child = spawn("/usr/sbin/sendmail", ["-t"], { stdio: ["pipe", "ignore", "pipe"] });
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

async function handle(req, res) {
	const url = new URL(req.url, "http://localhost");
	try {
		if (req.method === "GET" && url.pathname === "/") {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(html());
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
