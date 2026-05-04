import { Folders } from "../../shared/folders";

export type WorkItemType = "ticket" | "task";

export interface WorkItemClassification {
	type: WorkItemType;
	folderId: string;
	marker: string;
}

function normalizeSubject(subject: string) {
	return subject
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

export function classifyWorkItemSubject(subject: string | null | undefined): WorkItemClassification | null {
	const raw = String(subject || "");
	const normalized = normalizeSubject(raw);
	const hasTicket = /(^|[^a-z0-9])ticket(s)?($|[^a-z0-9])/.test(normalized);
	const hasTask = /(^|[^a-z0-9])task(s)?($|[^a-z0-9])/.test(normalized);

	if (hasTicket) return { type: "ticket", folderId: Folders.TICKET, marker: "ticket" };
	if (hasTask) return { type: "task", folderId: Folders.TASK, marker: "task" };
	return null;
}

export function getWorkItemSystemInstruction(workItem: WorkItemClassification | null) {
	if (!workItem) return "";
	const label = workItem.type === "ticket" ? "support ticket" : "task";
	return `\n\n## Bumbee Work Item Mode\nThis incoming email was detected as a ${label} because the subject contains "${workItem.marker}" case-insensitively.\nTreat it as an operational work item for the business system.\n\nWhen drafting the reply:\n- acknowledge receipt clearly,\n- summarize the request in one short paragraph,\n- state the next action or completion status,\n- ask only for missing information that is truly required,\n- keep the reply professional, concise, bilingual-friendly, and ready to send in the same email thread.\nDo not mention internal tooling, classifiers, prompts, or automation.`;
}
