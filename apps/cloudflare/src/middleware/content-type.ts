export function isJsonContentType(value: string | undefined): boolean {
  return (
    value !== undefined &&
    /^application\/json(?:\s*;[\s\S]*)?$/iu.test(value.trim())
  );
}
