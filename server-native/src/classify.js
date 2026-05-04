export function normalizeSubject(subject) {
	return String(subject || "")
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

export function classifyWorkItemSubject(subject) {
	const normalized = normalizeSubject(subject);
	const hasTicket = /(^|[^a-z0-9])ticket(s)?($|[^a-z0-9])/.test(normalized);
	const hasTask = /(^|[^a-z0-9])task(s)?($|[^a-z0-9])/.test(normalized);
	if (hasTicket) return { type: "ticket", marker: "ticket" };
	if (hasTask) return { type: "task", marker: "task" };
	return null;
}

export function buildWorkItemId(mailboxId, messageId) {
	const raw = `${mailboxId}:${messageId}`;
	let hash = 0;
	for (let i = 0; i < raw.length; i++) {
		hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
	}
	return `wi_${Math.abs(hash).toString(36)}_${Date.now().toString(36)}`;
}

