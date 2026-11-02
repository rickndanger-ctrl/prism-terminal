import { err, ok, type Result } from '@codex-lens/shared';
import { z } from 'zod';

export const REALTIME_CREDENTIALS_PATH = '/v1/realtime/credentials';

/** The long-lived OpenAI key lives in this env var, on the Mac, and never leaves. */
export const OPENAI_API_KEY_ENV = 'OPENAI_API_KEY';

// OpenAI's GA Realtime model (speech-to-speech with reasoning), confirmed target.
export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';

const nonEmptyString = z.string().trim().min(1);

/** What the phone asks the gateway for. */
export const RealtimeCredentialRequestSchema = z
  .object({
    model: nonEmptyString.optional(),
  })
  .strict();
export type RealtimeCredentialRequest = z.output<
  typeof RealtimeCredentialRequestSchema
>;

/**
 * The SHORT-LIVED credential handed back to the phone. It is scoped and
 * expiring; the phone uses it to open its own connection to OpenAI Realtime.
 * The long-lived key it was minted from stays on the gateway.
 */
export const RealtimeCredentialSchema = z
  .object({
    value: nonEmptyString,
    expiresAt: z.iso.datetime({ offset: true }),
    model: nonEmptyString,
    sessionId: nonEmptyString.optional(),
  })
  .strict()
  .readonly();
export type RealtimeCredential = z.output<typeof RealtimeCredentialSchema>;

/**
 * Mints a short-lived credential. The whole point of this seam: the phone
 * never sees the long-lived key. Injected so routes are testable without a
 * network call and the real key.
 */
export type RealtimeCredentialIssuer = (
  request: RealtimeCredentialRequest,
) => Promise<Result<RealtimeCredential>>;

export interface OpenAiRealtimeIssuerOptions {
  apiKey: string;
  defaultModel?: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * The 200 body of `POST /v1/realtime/client_secrets`: the ephemeral secret
 * (`value`) and its `expires_at` (unix seconds) are top-level, with the created
 * `session` (its id + resolved model) alongside. Parsed defensively — OpenAI may
 * add fields.
 */
const OpenAiClientSecretResponseSchema = z.looseObject({
  value: nonEmptyString,
  expires_at: z.number().int().positive(),
  session: z
    .looseObject({
      id: nonEmptyString.optional(),
      model: nonEmptyString.optional(),
    })
    .optional(),
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A production issuer that exchanges the long-lived key for a short-lived one
 * via OpenAI's official ephemeral-credential endpoint,
 * `POST /v1/realtime/client_secrets`. `fetchImpl` is injectable so this is
 * unit-tested against a stub — the live path is never exercised in tests.
 */
export function createOpenAiRealtimeIssuer(
  options: OpenAiRealtimeIssuerOptions,
): RealtimeCredentialIssuer {
  const baseUrl = options.baseUrl ?? DEFAULT_OPENAI_BASE_URL;
  const defaultModel = options.defaultModel ?? DEFAULT_REALTIME_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;

  return async (request) => {
    if (options.apiKey.trim().length === 0) {
      return err('REALTIME_KEY_MISSING', 'No OpenAI API key is configured.');
    }
    const model = request.model ?? defaultModel;

    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/realtime/client_secrets`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        // The client_secrets endpoint takes the session config it should mint a
        // secret for; `type: 'realtime'` selects the speech-to-speech session.
        body: JSON.stringify({ session: { type: 'realtime', model } }),
      });
    } catch (error) {
      return err('REALTIME_ISSUER_UNREACHABLE', errorMessage(error));
    }

    if (!response.ok) {
      // Deliberately no body: an upstream error must not leak into ours.
      return err(
        'REALTIME_ISSUER_REJECTED',
        `OpenAI rejected the credential request (status ${String(response.status)}).`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      return err('REALTIME_ISSUER_BAD_RESPONSE', errorMessage(error));
    }

    const parsed = OpenAiClientSecretResponseSchema.safeParse(body);
    if (!parsed.success) {
      return err(
        'REALTIME_ISSUER_BAD_RESPONSE',
        'OpenAI response did not contain a client secret.',
      );
    }

    const credential = {
      value: parsed.data.value,
      expiresAt: new Date(parsed.data.expires_at * 1000).toISOString(),
      model: parsed.data.session?.model ?? model,
      ...(parsed.data.session?.id === undefined
        ? {}
        : { sessionId: parsed.data.session.id }),
    };

    const validated = RealtimeCredentialSchema.safeParse(credential);
    if (!validated.success) {
      return err('REALTIME_ISSUER_BAD_RESPONSE', 'Minted credential was malformed.');
    }
    return ok(validated.data);
  };
}

/**
 * The default issuer for a running gateway: present only when the long-lived
 * key is configured. Absent → the route fails closed with 503, never a stub.
 */
export function realtimeIssuerFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RealtimeCredentialIssuer | undefined {
  const apiKey = env[OPENAI_API_KEY_ENV];
  if (apiKey === undefined || apiKey.trim().length === 0) {
    return undefined;
  }
  return createOpenAiRealtimeIssuer({ apiKey });
}
