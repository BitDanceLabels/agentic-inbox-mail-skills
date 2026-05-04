export function buildFallbackReply({ message, classification }) {
	const label = classification.type === "ticket" ? "ticket" : "task";
	const subject = message.subject || `${label} request`;
	const body = message.bodyText || message.bodyHtml || "";
	const summary = body.replace(/\s+/g, " ").trim().slice(0, 220);
	return [
		`Hi,`,
		``,
		`Bumbee has received this ${label}: "${subject}".`,
		summary ? `I summarized the request as: ${summary}` : `I will review the request details and update this thread.`,
		``,
		`Next action: I will route this to the right AI/workflow handler and reply with the result or any missing information needed.`,
		``,
		`Best,`,
		`Bumbee Operations`,
	].join("\n");
}

export async function generateReply({ message, classification, mailboxId, config = {} }) {
	const endpoint =
		config.aiEndpoint ||
		process.env.BUMBBEE_MAIL_AI_ENDPOINT ||
		process.env.BUMBEE_MAIL_AI_ENDPOINT;
	if (!endpoint) return buildFallbackReply({ message, classification });

	const payload = {
		mailbox_id: mailboxId,
		type: classification.type,
		subject: message.subject,
		from: message.from,
		body: message.bodyText || message.bodyHtml || "",
		instructions: "Create a concise professional reply for the same email thread. Do not mention internal tooling.",
	};
	const headers = { "Content-Type": "application/json" };
	const token = config.aiToken || process.env.BUMBEE_MAIL_AI_TOKEN;
	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}
	const res = await fetch(endpoint, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
	});
	if (!res.ok) throw new Error(`AI endpoint failed: HTTP ${res.status}`);
	const data = await res.json();
	return data.reply || data.answer || data.text || buildFallbackReply({ message, classification });
}
