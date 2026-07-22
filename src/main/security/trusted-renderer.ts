export type TrustedRendererLocation =
  { kind: 'development-origin'; origin: string } | { kind: 'packaged-file'; url: string };

/** Creates the immutable location policy used by every privileged IPC handler. */
export function createTrustedRendererLocation(
  rendererEntryUrl: string,
  development: boolean,
): TrustedRendererLocation {
  const parsed = new URL(rendererEntryUrl);

  if (development) {
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new TypeError('The development renderer must use HTTP or HTTPS');
    }
    return { kind: 'development-origin', origin: parsed.origin };
  }

  if (parsed.protocol !== 'file:') {
    throw new TypeError('The packaged renderer must use a file URL');
  }
  return { kind: 'packaged-file', url: parsed.href };
}

/**
 * Development navigation is restricted to the Vite server's exact origin.
 * Packaged navigation is stricter: only the exact built renderer file is trusted.
 */
export function isTrustedRendererUrl(
  candidateUrl: string,
  trustedLocation: TrustedRendererLocation,
): boolean {
  let candidate: URL;
  try {
    candidate = new URL(candidateUrl);
  } catch {
    return false;
  }

  if (trustedLocation.kind === 'development-origin') {
    return (
      (candidate.protocol === 'http:' || candidate.protocol === 'https:') &&
      candidate.origin === trustedLocation.origin
    );
  }

  return candidate.protocol === 'file:' && candidate.href === trustedLocation.url;
}
