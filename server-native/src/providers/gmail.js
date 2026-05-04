function base64Url(input) {
	return Buffer.from(input, "utf8")
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

async function refreshAccessToken(mailbox) {
	if (!mailbox.refreshToken || !mailbox.clientId || !mailbox.clientSecret) return mailbox.accessToken;
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: mailbox.clientId,
			client_secret: mailbox.clientSecret,
			refresh_token: mailbox.refreshToken,
			grant_type: "refresh_token",
		}),
	});
	if (!res.ok) throw new Error(`Gmail token refresh failed: HTTP ${res.status}`);
	const data = await res.json();
	mailbox.accessToken = data.access_token;
	return mailbox.accessToken;
}

function headerValue(headers, name) {
	return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

export function createGmailProvider(mailbox) {
	async function gmailFetch(path, options = {}) {
		const token = await refreshAccessToken(mailbox);
		const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
			...options,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				...(options.headers || {}),
			},
		});
		if (!res.ok) throw new Error(`Gmail API failed ${path}: HTTP ${res.status}`);
		return res.json();
	}

	return {
		async listMessages() {
			const list = await gmailFetch("/messages?q=is:unread newer_than:30d&maxResults=20");
			const ids = list.messages || [];
			const messages = [];
			for (const item of ids) {
				const full = await gmailFetch(`/messages/${item.id}?format=full`);
				const headers = full.payload?.headers || [];
				messages.push({
					id: full.id,
					threadId: full.threadId,
					provider: "gmail",
					from: headerValue(headers, "From"),
					to: headerValue(headers, "To") || mailbox.id,
					subject: headerValue(headers, "Subject"),
					messageIdHeader: headerValue(headers, "Message-ID"),
					references: headerValue(headers, "References"),
					bodyText: full.snippet || "",
				});
			}
			return messages;
		},
		async reply(message, replyText) {
			const subject = message.subject?.toLowerCase().startsWith("re:") ? message.subject : `Re: ${message.subject}`;
			const raw = [
				`To: ${message.from}`,
				`From: ${mailbox.id}`,
				`Subject: ${subject}`,
				message.messageIdHeader ? `In-Reply-To: ${message.messageIdHeader}` : "",
				message.references ? `References: ${message.references} ${message.messageIdHeader || ""}` : "",
				"Content-Type: text/plain; charset=utf-8",
				"",
				replyText,
			].filter(Boolean).join("\r\n");
			return gmailFetch("/messages/send", {
				method: "POST",
				body: JSON.stringify({ raw: base64Url(raw), threadId: message.threadId }),
			});
		},
	};
}

