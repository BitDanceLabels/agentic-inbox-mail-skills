export function createMockProvider(mailbox, store) {
	const messages = mailbox.messages || [
		{
			id: "mock-ticket-1",
			subject: "[ticket] Website checkout issue",
			from: "customer@example.com",
			bodyText: "The payment button does not work on mobile. Please check and reply.",
			threadId: "mock-thread-1",
		},
		{
			id: "mock-task-1",
			subject: "[TASK] Prepare weekly sales report",
			from: "manager@example.com",
			bodyText: "Please prepare a short weekly sales report for the team.",
			threadId: "mock-thread-2",
		},
	];

	return {
		async listMessages() {
			return messages.map((message) => ({
				...message,
				to: mailbox.id,
				provider: "mock",
			}));
		},
		async reply(message, replyText) {
			const entry = {
				provider: "mock",
				mailboxId: mailbox.id,
				messageId: message.id,
				threadId: message.threadId || message.id,
				to: message.from,
				subject: message.subject?.toLowerCase().startsWith("re:") ? message.subject : `Re: ${message.subject}`,
				bodyText: replyText,
				createdAt: new Date().toISOString(),
			};
			await store.addOutbox(entry);
			return { status: "mock_sent", entry };
		},
	};
}

