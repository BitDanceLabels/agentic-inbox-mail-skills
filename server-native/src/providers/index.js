import { createMockProvider } from "./mock.js";
import { createGmailProvider } from "./gmail.js";
import { createMicrosoftProvider } from "./microsoft.js";

export function createProvider(mailbox, store) {
	if (mailbox.provider === "mock") return createMockProvider(mailbox, store);
	if (mailbox.provider === "gmail") return createGmailProvider(mailbox, store);
	if (mailbox.provider === "microsoft") return createMicrosoftProvider(mailbox, store);
	throw new Error(`Unsupported mailbox provider: ${mailbox.provider}`);
}

