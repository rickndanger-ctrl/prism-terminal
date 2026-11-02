import { err } from '@codex-lens/shared';
import { openGmailAccount, type GmailCredentialStore } from './gmailAccount.js';
import { createGmailConnection } from './gmailConnection.js';
import { createGmailKeychainStore } from './gmailKeychain.js';
import { refreshGoogleGrant } from './googleRefresh.js';
import { createGmailReader, type GmailReader } from './gmailReader.js';
import { createGmailIdentity, type GmailIdentity } from './gmailIdentity.js';
import { createGmailWriter } from './gmailWriter.js';
import { createGmailIntentStore } from './gmailIntentStore.js';
import { acceptsGmailPhoneApproval } from './gmailPhoneApproval.js';
import type { Db } from '../db/schema.js';

/** Activate only after acquiring the canonical gateway listener. Until then,
 * no Keychain access occurs. Optional Gmail failures never stop core services.
 */
export function createGmailRuntime(options: {
  clientId: string;
  clientSecret?: string;
  store?: GmailCredentialStore;
}) {
  let connection: ReturnType<typeof createGmailConnection> | undefined;
  let activation: Promise<void> | undefined;
  let closed = false;
  let reader: GmailReader | undefined;
  let identity: GmailIdentity | undefined;
  let intents: ReturnType<typeof createGmailIntentStore> | undefined;
  let writer: ReturnType<typeof createGmailWriter> | undefined;
  let writesClosed = false;
  let account: Awaited<ReturnType<typeof openGmailAccount>> | undefined;
  const unavailable = () => err('GMAIL_NOT_READY', 'Gmail is not ready. Check its Mac configuration and Keychain access.');
  return {
    writerForDb(db: Db): ReturnType<typeof createGmailWriter> {
      if (intents || activation || closed) throw new Error('Gmail write store must be attached once before activation.');
      intents = createGmailIntentStore(db);
      return {
        async prepare(input: unknown) { return writer && !closed && !writesClosed ? writer.prepare(input) : unavailable(); },
        async execute(id: string, digest: string, approval: unknown) {
          return writer && !closed && !writesClosed ? writer.execute(id, digest, approval) : unavailable();
        },
        status(id: string) { return writer && !closed && !writesClosed ? writer.status(id) : undefined; },
        cancel(id: string) { return writer && !closed && !writesClosed ? writer.cancel(id) : false; },
        async close() { writesClosed = true; await writer?.close(); },
      };
    },
    async identity() { return identity && !closed ? identity() : unavailable(); },
    reader: {
      async search(query: string, pageToken?: string) { return reader && !closed ? reader.search(query, pageToken) : unavailable(); },
      async readText(id: string) { return reader && !closed ? reader.readText(id) : unavailable(); },
    },
    connection: {
      async begin(features: Parameters<ReturnType<typeof createGmailConnection>['begin']>[0]) {
        return connection && !closed ? connection.begin(features) : unavailable();
      },
      cancel() { connection?.cancel(); },
      async disconnectLocal() {
        return connection && !closed ? connection.disconnectLocal() : unavailable();
      },
    },
    activate(): Promise<void> {
      activation ??= (async () => {
        if (closed || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/u.test(options.clientId)) return;
        try {
          intents?.recoverOwnedStartup();
          account = await openGmailAccount({ store: options.store ?? createGmailKeychainStore(),
            refresh: (grant, signal) => refreshGoogleGrant(grant, { clientId: options.clientId, signal,
              ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }) }) });
          if (closed) return;
          reader = createGmailReader({ account });
          identity = createGmailIdentity({ account });
          if (intents && !writesClosed) writer = createGmailWriter({ account, identity, store: intents,
            authorize: async (approval, preview) => acceptsGmailPhoneApproval(approval, preview) });
          connection = createGmailConnection({ account, clientId: options.clientId,
            ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }) });
        } catch {
          // Do not log native output, credentials or private storage errors.
          // Leave Gmail unavailable; voice and computer control keep running.
        }
      })();
      return activation;
    },
    async close(): Promise<void> {
      closed = true;
      connection?.cancel();
      connection = undefined;
      reader = undefined;
      identity = undefined;
      await activation;
      writesClosed = true;
      try { await writer?.close(); } finally { await account?.close(); }
    },
  };
}
