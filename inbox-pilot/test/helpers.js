import { useMemoryStore } from "../lib/store.js";
import { setProviders } from "../lib/providers.js";
import { saveAccount } from "../lib/accounts.js";
import { buildMailbox, createFakeGmail } from "../dev/fake-mailbox.js";
import * as fakeAi from "../dev/fake-ai.js";

process.env.APP_SECRET ||= "test-secret-test-secret-test-secret-123";
process.env.APP_PASSWORD ||= "hunter2";

export async function setupFakeWorld() {
  const store = useMemoryStore();
  const mailbox = buildMailbox();
  const account = { id: "acc_test", provider: "gmail", email: "kaye@example.com", label: "Personal", color: "#2f6f62", refreshToken: "x", status: "ok", createdAt: 1 };
  await saveAccount(account);
  const gmail = createFakeGmail(account, mailbox);
  setProviders({ gmailFor: () => gmail, ai: fakeAi });
  return { store, mailbox, account, gmail };
}
