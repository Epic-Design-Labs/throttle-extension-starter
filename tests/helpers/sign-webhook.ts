function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function signWebhook(input: {
  rawBody: string;
  secret: string;
  timestamp: number;
}): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${input.timestamp}.${input.rawBody}`),
  );
  return `t=${input.timestamp},v1=${hex(new Uint8Array(signature))}`;
}
