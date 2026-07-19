import { HttpError, invalidRequest } from './errors.js';

export async function readBoundedUtf8Body(input: {
  request: Request;
  maxBytes: number;
  tooLargeCode: string;
}): Promise<string> {
  const contentLength = input.request.headers.get('content-length');
  if (
    contentLength !== null &&
    (!/^[0-9]+$/u.test(contentLength) || Number(contentLength) > input.maxBytes)
  )
    throw new HttpError(413, input.tooLargeCode, 'The request is too large.');
  if (input.request.body === null) throw invalidRequest();
  const reader = input.request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > input.maxBytes) {
      await reader.cancel();
      for (const chunk of chunks) chunk.fill(0);
      value.fill(0);
      throw new HttpError(413, input.tooLargeCode, 'The request is too large.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw invalidRequest();
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}
