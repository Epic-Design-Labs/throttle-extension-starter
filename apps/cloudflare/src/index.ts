import type { CloudflareQueueMessageBatch } from '@starter/adapters-cloudflare-queue';
import { composeWorker } from './composition/index.js';
import type { Env } from './env.js';

const compositions = new WeakMap<object, ReturnType<typeof composeWorker>>();
function composition(env: Env) {
  const key = env as object;
  let value = compositions.get(key);
  if (!value) {
    value = composeWorker(env);
    compositions.set(key, value);
  }
  return value;
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return Promise.resolve(composition(env).app.fetch(request));
  },
  queue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
    return composition(env).queue(
      batch as unknown as CloudflareQueueMessageBatch,
    );
  },
} satisfies ExportedHandler<Env>;
