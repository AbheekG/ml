export function wellFormedFilename(value: string): string {
  return new TextDecoder().decode(new TextEncoder().encode(value));
}

export function truncateFilename(value: string, maximumCodePoints: number): string {
  return Array.from(wellFormedFilename(value)).slice(0, maximumCodePoints).join("");
}

export function encodeRfc5987Filename(value: string): string {
  return encodeURIComponent(wellFormedFilename(value)).replace(
    /[!'()*]/gu,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
