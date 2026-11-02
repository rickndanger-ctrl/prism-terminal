import { createHash } from 'node:crypto';
import { err, ok } from '@codex-lens/shared';
import type { openGmailAccount } from './gmailAccount.js';
import { createGmailClient } from './gmailClient.js';

/** Resolve the account from Google's authenticated `me` profile, never model
 * arguments. Send-only Gmail scope cannot call this endpoint; do not silently
 * expand the grant. All identity data is discarded on account changes.
 */
export function createGmailIdentity(options: {
  account: Pick<Awaited<ReturnType<typeof openGmailAccount>>, 'accessToken' | 'revision' | 'authorizedScopes'>;
  fetchImpl?: typeof fetch;
}) {
  return async () => {
    const account = options.account;
    const revision = account.revision();
    const scope = ['gmail.readonly', 'gmail.compose'].map(value => `https://www.googleapis.com/auth/${value}`)
      .find(value => account.authorizedScopes().includes(value));
    if (!scope) return err('GMAIL_IDENTITY_SCOPE_REQUIRED', 'Verify Gmail identity with authorized read or draft access. Send-only access cannot verify the sending address.');
    const token = await account.accessToken([scope]);
    const changed = () => err('GMAIL_ACCOUNT_CHANGED', 'The Gmail account changed during identity verification.');
    if (account.revision() !== revision) return changed();
    if (!token.ok) return token;
    const client = createGmailClient({ accessToken: async () => account.revision() === revision ? token.value : undefined,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
    const profile = await client.profile();
    if (account.revision() !== revision) return changed();
    if (!profile.ok) return profile;
    const emailAddress = profile.value.emailAddress;
    return ok({ emailAddress, accountBinding: createHash('sha256').update(emailAddress.toLowerCase()).digest('hex'), revision });
  };
}
export type GmailIdentity = ReturnType<typeof createGmailIdentity>;
