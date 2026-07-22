const MAX_BROWSER_URL_LENGTH = 4_096;
const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;

function containsControlCharacters(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/**
 * Converts an address-bar value into an explicitly safe browser URL.
 * Remote content is intentionally limited to HTTP(S); local files, data URLs,
 * JavaScript URLs and privileged Electron/Chromium schemes are never accepted.
 */
export function normalizeBrowserUrl(input: string): string {
  const value = input.trim();
  if (
    value.length === 0 ||
    value.length > MAX_BROWSER_URL_LENGTH ||
    containsControlCharacters(value)
  ) {
    throw new TypeError('Enter a valid web address');
  }

  if (value === 'about:blank') {
    return value;
  }

  const candidate = EXPLICIT_SCHEME_PATTERN.test(value) ? value : `https://${value}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new TypeError('Enter a valid HTTP or HTTPS address');
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError('Only HTTP and HTTPS addresses are supported');
  }

  if (!parsed.hostname || parsed.username || parsed.password) {
    throw new TypeError('The address must contain a host and cannot include credentials');
  }

  if (parsed.href.length > MAX_BROWSER_URL_LENGTH) {
    throw new TypeError('The address is too long');
  }

  return parsed.href;
}

export function isAllowedBrowserUrl(input: string): boolean {
  try {
    normalizeBrowserUrl(input);
    return true;
  } catch {
    return false;
  }
}
