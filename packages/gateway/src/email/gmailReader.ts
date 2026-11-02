import { err, type Result } from '@codex-lens/shared';
import type { openGmailAccount } from './gmailAccount.js';
import { createGmailClient } from './gmailClient.js';

export function createGmailReader(options: {
  account: Pick<Awaited<ReturnType<typeof openGmailAccount>>, 'accessToken' | 'revision'>;
  fetchImpl?: typeof fetch;
}) {
  const account = options.account;
  async function read<T>(action: (client: ReturnType<typeof createGmailClient>) => Promise<Result<T>>): Promise<Result<T>> {
    const revision = account.revision();
    const changed = () => err('GMAIL_ACCOUNT_CHANGED', 'Gmail account changed. Request this email again.');
    const token = await account.accessToken(['https://www.googleapis.com/auth/gmail.readonly']);
    if (revision !== account.revision()) return changed();
    if (!token.ok) return token;
    const client = createGmailClient({ accessToken: async () => revision === account.revision() ? token.value : undefined,
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }) });
    const result = await action(client);
    return revision === account.revision() ? result : changed();
  }
  return {
    search: (query: string, pageToken?: string) => read(client => client.search(query, pageToken)),
    readText: (messageId: string) => read(client => client.readText(messageId)),
  };
}
export type GmailReader = ReturnType<typeof createGmailReader>;
