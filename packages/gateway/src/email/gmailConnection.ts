import { err, type Result } from '@codex-lens/shared';
import type { openGmailAccount } from './gmailAccount.js';
import { startGoogleLoopback } from './googleLoopback.js';
import type { GmailFeature } from './googleAuthorization.js';

/** Host-owned sign-in flow. The caller exclusively owns the account controller.
 * No credentials escape through completion, and browser consent alone is not
 * reported as a connection: persistence must succeed first.
 */
export function createGmailConnection(options: {
  account: Pick<Awaited<ReturnType<typeof openGmailAccount>>, 'connect' | 'disconnectLocal'>;
  clientId: string;
  clientSecret?: string;
  start?: typeof startGoogleLoopback;
}) {
  let generation = 0;
  let pending: Awaited<ReturnType<typeof startGoogleLoopback>> | undefined;
  const cancelled = () => err('GMAIL_AUTH_CANCELLED', 'This Gmail connection attempt is no longer active.');
  function cancel(): void {
    generation += 1;
    pending?.cancel();
    pending = undefined;
  }
  return {
    async begin(features: readonly GmailFeature[]): Promise<Result<{
      authorizationURL: string;
      completion: Promise<Result<void>>;
    }>> {
      cancel();
      const epoch = generation;
      let flow: Awaited<ReturnType<typeof startGoogleLoopback>>;
      try {
        flow = await (options.start ?? startGoogleLoopback)({ clientId: options.clientId,
          ...(options.clientSecret === undefined ? {} : { clientSecret: options.clientSecret }), features });
      } catch {
        return err('GMAIL_AUTH_START_FAILED', 'Gmail sign-in could not start. Check the Google desktop client configuration.');
      }
      if (generation !== epoch) { flow.cancel(); return cancelled(); }
      pending = flow;
      const completion = (async (): Promise<Result<void>> => {
        try {
          const grant = await flow.completion;
          if (generation !== epoch) return cancelled();
          if (!grant.ok) return grant;
          const saved = await options.account.connect(grant.value);
          if (generation !== epoch) return cancelled();
          return saved;
        } catch {
          return err('GMAIL_AUTH_FAILED', 'Gmail connection did not complete.');
        } finally {
          if (pending === flow) pending = undefined;
        }
      })();
      return { ok: true, value: { authorizationURL: flow.authorizationURL, completion } };
    },
    // Cancels browser authorization, not an already-started credential save.
    // To disable the account as well, use disconnectLocal.
    cancel,
    async disconnectLocal(): Promise<Result<void>> {
      cancel();
      return options.account.disconnectLocal();
    },
  };
}
