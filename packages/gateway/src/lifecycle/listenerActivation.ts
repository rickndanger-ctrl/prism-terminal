import type { FastifyInstance } from 'fastify';

interface ListenerActivation {
  readonly label: string;
  readonly activate: () => void;
}

interface ListenerActivationState {
  readonly activations: ListenerActivation[];
  readonly completion: Promise<void>;
  readonly complete: () => void;
  started: boolean;
  failure?: Error;
  closePromise?: Promise<void>;
}

const activationStates = new WeakMap<FastifyInstance, ListenerActivationState>();

function errorFrom(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function stateFor(server: FastifyInstance): ListenerActivationState {
  const existing = activationStates.get(server);
  if (existing !== undefined) return existing;

  let complete!: () => void;
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const state: ListenerActivationState = {
    activations: [],
    completion,
    complete,
    started: false,
  };
  activationStates.set(server, state);

  server.addHook('onListen', () => {
    if (state.started) return;
    state.started = true;

    for (const activation of state.activations) {
      try {
        activation.activate();
      } catch (cause) {
        const activationError = errorFrom(cause);
        state.failure = new Error(
          `${activation.label} activation failed: ${activationError.message}`,
        );
        server.log.error(
          { err: activationError, service: activation.label },
          'Owned-listener activation failed; closing gateway listener',
        );
        state.closePromise = server.close().catch((closeCause: unknown) => {
          server.log.error(
            { err: closeCause, service: activation.label },
            'Gateway close failed after owned-listener activation error',
          );
        });
        break;
      }
    }

    state.complete();
  });

  return state;
}

/**
 * Registers recovery that may mutate durable state. Fastify invokes it only
 * after this process successfully owns the listener, so a duplicate process
 * that loses its bind cannot reconcile the live owner's rows.
 */
export function registerOwnedListenerActivation(
  server: FastifyInstance,
  label: string,
  activate: () => void,
): void {
  const state = stateFor(server);
  if (state.started) {
    throw new Error(`Cannot register ${label} activation after the listener started`);
  }
  state.activations.push({ label, activate });
}

/**
 * Converts Fastify's non-fatal onListen hook semantics into a startup failure.
 * `start()` calls this immediately after listen() so a supervisor can restart
 * the gateway instead of leaving a closed, apparently healthy process alive.
 */
export async function waitForOwnedListenerActivations(
  server: FastifyInstance,
): Promise<void> {
  const state = activationStates.get(server);
  if (state === undefined) return;

  // Unit tests may replace Fastify.listen() with a no-op. In a real successful
  // bind, node's listener is active before Fastify resolves listen().
  if (!state.started && !server.server.listening) return;

  await state.completion;
  if (state.failure !== undefined) {
    await state.closePromise;
    throw state.failure;
  }
}
