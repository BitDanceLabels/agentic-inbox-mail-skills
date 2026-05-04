async function refreshAccessToken(mailbox) {
	if (!mailbox.refreshToken || !mailbox.clientId || !mailbox.clientSecret) return mailbox.accessToken;
	const tenantId = mailbox.tenantId || "common";
	const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: mailbox.clientId,
			client_secret: mailbox.clientSecret,
			refresh_token: mailbox.refreshToken,
			grant_type: "refresh_token",
			scope: "offline_access Mail.ReadWrite Mail.Send",
		}),
	});
	if (!res.ok) throw new Error(`Microsoft token refresh failed: HTTP ${res.status}`);
	const data = await res.json();
	mailbox.accessToken = data.access_token;
	return mailbox.accessToken;
}

export function createMicrosoftProvider(mailbox) {
	async function graph(path, options = {}) {
		const token = await refreshAccessToken(mailbox);
		const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
			...options,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
				...(options.headers || {}),
			},
		});
		if (!res.ok) throw new Error(`Microsoft Graph failed ${path}: HTTP ${res.status}`);
		if (res.status === 204) return {};
		return res.json();
	}

	return {
		async listMessages() {
			const data = await graph("/me/mailFolders/inbox/messages?$top=20&$orderby=receivedDateTime desc&$filter=isRead eq false");
			return (data.value || []).map((message) => ({
				id: message.id,
				threadId: message.conversationId,
				provider: "microsoft",
				from: message.from?.emailAddress?.address || "",
				to: mailbox.id,
				subject: message.subject || "",
				bodyText: message.bodyPreview || "",
				bodyHtml: message.body?.content || "",
			}));
		},
		async reply(message, replyText) {
			return graph(`/me/messages/${encodeURIComponent(message.id)}/reply`, {
				method: "POST",
				body: JSON.stringify({ comment: replyText }),
			});
		},
	};
}

