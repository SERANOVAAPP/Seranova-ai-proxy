import { getStore, keys } from "./store.js";

// Connected mailboxes. Refresh tokens are stored encrypted (see crypto.js)
// and never leave the server.

export const ACCOUNT_COLORS = ["#2f6f62", "#b5563c", "#5b5fc7", "#a2741c", "#8a4f8f", "#3d7ea6"];

export async function listAccounts() {
  const store = await getStore();
  return Object.values(await store.hgetall(keys.accounts)).sort((a, b) => a.createdAt - b.createdAt);
}

export async function getAccount(id) {
  const store = await getStore();
  return store.hget(keys.accounts, id);
}

export async function saveAccount(account) {
  const store = await getStore();
  await store.hset(keys.accounts, { [account.id]: account });
  return account;
}

export async function removeAccount(id) {
  const store = await getStore();
  await store.hdel(keys.accounts, id);
  await store.del(keys.sync(id));
}

export function publicAccount(a) {
  return { id: a.id, provider: a.provider, email: a.email, label: a.label, color: a.color, status: a.status || "ok", statusMessage: a.statusMessage || "", createdAt: a.createdAt };
}
