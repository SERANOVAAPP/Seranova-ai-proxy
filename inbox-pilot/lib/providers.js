import { createGmailClient } from "./google.js";
import * as ai from "./ai.js";

// The two outside services the app talks to. Tests and demo mode swap
// these for fakes; production uses Gmail and Claude.
export const providers = {
  gmailFor: (account) => createGmailClient(account),
  ai,
};

export function setProviders(overrides) {
  Object.assign(providers, overrides);
}
