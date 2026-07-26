'use strict';

const { crc32, inflateRawSync } = require('node:zlib');

const AUDIT_PATH = '/-/npm/v1/security/advisories/bulk';
const AUDIT_REGISTRY = 'https://registry.npmjs.org/';
const AUDIT_URL = new URL(AUDIT_PATH, AUDIT_REGISTRY).href;
const MAX_WIRE_BYTES = 8 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_READ_TIME_MS = 30_000;
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b, 0x08]);
const COPIED_FUNCTION_PROPERTIES = new Set(['arguments', 'caller', 'length', 'name', 'prototype']);

class AuditResponseCompatibilityError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AuditResponseCompatibilityError';
    this.code = 'EAUDITRESPONSECOMPAT';
  }
}

function createCompatibleRegistryFetch(originalFetch, options = {}) {
  if (typeof originalFetch !== 'function') {
    throw new AuditResponseCompatibilityError(
      'npm-registry-fetch did not export the expected function.',
    );
  }

  const onCompatibility = options.onCompatibility;
  if (onCompatibility !== undefined && typeof onCompatibility !== 'function') {
    throw new TypeError('onCompatibility must be a function when provided.');
  }

  const compatibleFetch = async function compatibleRegistryFetch(uri, fetchOptions = {}) {
    if (!isExactAuditRequest(uri, fetchOptions)) {
      return originalFetch(uri, fetchOptions);
    }

    const response = await originalFetch(uri, fetchOptions);
    if (!isExactAuditResponse(response)) return response;

    if (typeof response.headers?.get !== 'function') {
      throw new AuditResponseCompatibilityError(
        'npm audit returned an unsupported response headers object.',
      );
    }
    const contentEncoding = response.headers.get('content-encoding');
    if (contentEncoding !== null) return response;

    if (typeof response.clone !== 'function') {
      throw new AuditResponseCompatibilityError(
        'npm audit returned a headerless response that could not be inspected safely.',
      );
    }
    const probe = response.clone();
    if (!probe.body || typeof probe.body[Symbol.asyncIterator] !== 'function') {
      throw new AuditResponseCompatibilityError(
        'npm audit returned a headerless response without a readable clone.',
      );
    }
    const timeout =
      Number.isFinite(response.timeout) && response.timeout > 0
        ? Math.min(response.timeout, MAX_READ_TIME_MS)
        : MAX_READ_TIME_MS;
    const prefix = await readBodyPrefix(probe.body, GZIP_MAGIC.length, timeout);
    if (!startsWithGzipMagic(prefix)) return response;

    const expectedPackages = validateAuditRequestBody(fetchOptions.body);
    installCompatibleJsonReader(response, expectedPackages, onCompatibility);
    return response;
  };

  for (const property of Reflect.ownKeys(originalFetch)) {
    if (COPIED_FUNCTION_PROPERTIES.has(property)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(originalFetch, property);
    if (descriptor) Object.defineProperty(compatibleFetch, property, descriptor);
  }

  return compatibleFetch;
}

function isExactAuditRequest(uri, options = {}) {
  if (
    uri !== AUDIT_PATH ||
    !isRecord(options) ||
    String(options.method ?? 'GET').toUpperCase() !== 'POST' ||
    options.gzip !== true ||
    options.query !== undefined ||
    typeof options.registry !== 'string'
  ) {
    return false;
  }

  try {
    const registry = new URL(options.registry);
    return (
      registry.href === AUDIT_REGISTRY &&
      registry.username === '' &&
      registry.password === '' &&
      registry.search === '' &&
      registry.hash === ''
    );
  } catch {
    return false;
  }
}

function isExactAuditResponse(response) {
  if (!isRecord(response) || response.status !== 200 || typeof response.url !== 'string') {
    return false;
  }

  try {
    const url = new URL(response.url);
    return (
      url.href === AUDIT_URL &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function installCompatibleJsonReader(response, expectedPackages, onCompatibility) {
  if (
    typeof response.json !== 'function' ||
    !response.body ||
    typeof response.body[Symbol.asyncIterator] !== 'function'
  ) {
    throw new AuditResponseCompatibilityError('npm audit returned an unsupported response object.');
  }

  let consumed = false;
  response.json = async () => {
    if (consumed || response.bodyUsed) {
      throw new TypeError(`body used already for: ${response.url}`);
    }
    consumed = true;

    const declaredLength = parseContentLength(response.headers?.get?.('content-length'));
    if (declaredLength !== null && declaredLength > MAX_WIRE_BYTES) {
      throw new AuditResponseCompatibilityError(
        `npm audit response declared ${declaredLength} bytes, above the ${MAX_WIRE_BYTES}-byte wire limit.`,
      );
    }

    const timeout =
      Number.isFinite(response.timeout) && response.timeout > 0
        ? Math.min(response.timeout, MAX_READ_TIME_MS)
        : MAX_READ_TIME_MS;
    const wire = await readBodyWithLimit(response.body, MAX_WIRE_BYTES, timeout);
    if (declaredLength !== null && declaredLength !== wire.length) {
      throw new AuditResponseCompatibilityError(
        `npm audit response declared ${declaredLength} bytes but delivered ${wire.length}.`,
      );
    }

    const decoded = parseAuditJsonBody(wire, {
      maxWireBytes: MAX_WIRE_BYTES,
      maxDecompressedBytes: MAX_DECOMPRESSED_BYTES,
    });
    validateAuditResponseBody(decoded.value, expectedPackages);

    if (decoded.wasGzip) {
      onCompatibility?.({
        wireBytes: wire.length,
        decodedBytes: decoded.decodedBytes,
      });
    }
    return decoded.value;
  };
}

async function readBodyWithLimit(body, maxBytes, timeoutMs) {
  validatePositiveInteger(maxBytes, 'maxBytes');
  validatePositiveInteger(timeoutMs, 'timeoutMs');

  const chunks = [];
  let totalBytes = 0;
  let timeout;
  const timeoutError = new AuditResponseCompatibilityError(
    `npm audit response body exceeded the ${timeoutMs}ms read limit.`,
  );
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      if (typeof body.destroy === 'function') body.destroy(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
  });

  const readPromise = (async () => {
    for await (const chunk of body) {
      const buffer = toBinaryBuffer(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        const error = new AuditResponseCompatibilityError(
          `npm audit response exceeded the ${maxBytes}-byte wire limit.`,
        );
        if (typeof body.destroy === 'function') body.destroy(error);
        throw error;
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, totalBytes);
  })();

  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function readBodyPrefix(body, byteCount, timeoutMs) {
  validatePositiveInteger(byteCount, 'byteCount');
  validatePositiveInteger(timeoutMs, 'timeoutMs');

  const chunks = [];
  let totalBytes = 0;
  let prefixSettled = false;
  let timeout;
  const timeoutError = new AuditResponseCompatibilityError(
    `npm audit response body exceeded the ${timeoutMs}ms inspection limit.`,
  );
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      if (typeof body.destroy === 'function') body.destroy(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
    timeout.unref?.();
  });

  const prefixPromise = new Promise((resolve, reject) => {
    void (async () => {
      try {
        for await (const chunk of body) {
          const buffer = toBinaryBuffer(chunk);
          if (totalBytes < byteCount) {
            const remaining = byteCount - totalBytes;
            const consumedBytes = Math.min(buffer.length, remaining);
            chunks.push(buffer.subarray(0, consumedBytes));
            totalBytes += consumedBytes;
          }
          if (!prefixSettled && totalBytes === byteCount) {
            prefixSettled = true;
            resolve(Buffer.concat(chunks, totalBytes));
          }
        }
        if (!prefixSettled) {
          prefixSettled = true;
          resolve(Buffer.concat(chunks, totalBytes));
        }
      } catch (error) {
        if (!prefixSettled) {
          prefixSettled = true;
          reject(error);
        }
      }
    })();
  });

  try {
    return await Promise.race([prefixPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

function toBinaryBuffer(chunk) {
  if (!Buffer.isBuffer(chunk) && !ArrayBuffer.isView(chunk)) {
    throw new AuditResponseCompatibilityError(
      'npm audit response body contained a non-binary chunk.',
    );
  }
  return Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function parseAuditJsonBody(
  wire,
  { maxWireBytes = MAX_WIRE_BYTES, maxDecompressedBytes = MAX_DECOMPRESSED_BYTES } = {},
) {
  if (!Buffer.isBuffer(wire)) {
    throw new TypeError('wire must be a Buffer.');
  }
  validatePositiveInteger(maxWireBytes, 'maxWireBytes');
  validatePositiveInteger(maxDecompressedBytes, 'maxDecompressedBytes');
  if (wire.length > maxWireBytes) {
    throw new AuditResponseCompatibilityError(
      `npm audit response exceeded the ${maxWireBytes}-byte wire limit.`,
    );
  }

  const wasGzip = startsWithGzipMagic(wire);
  const decoded = wasGzip ? decodeSingleGzipMember(wire, maxDecompressedBytes) : Buffer.from(wire);
  if (decoded.length > maxDecompressedBytes) {
    throw new AuditResponseCompatibilityError(
      `npm audit response exceeded the ${maxDecompressedBytes}-byte decoded limit.`,
    );
  }

  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
  } catch (cause) {
    throw new AuditResponseCompatibilityError('npm audit response was not valid UTF-8.', { cause });
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new AuditResponseCompatibilityError('npm audit response was not valid JSON.', { cause });
  }
  if (!isRecord(value)) {
    throw new AuditResponseCompatibilityError('npm audit response JSON must be an object.');
  }

  return {
    value,
    wasGzip,
    decodedBytes: decoded.length,
  };
}

function decodeSingleGzipMember(wire, maxOutputLength) {
  let headerEnd;
  try {
    headerEnd = parseGzipHeader(wire);
  } catch (cause) {
    if (cause instanceof AuditResponseCompatibilityError) throw cause;
    throw new AuditResponseCompatibilityError(
      'npm audit response contained an invalid gzip header.',
      { cause },
    );
  }

  if (wire.length < headerEnd + 10) {
    throw new AuditResponseCompatibilityError(
      'npm audit response contained a truncated gzip member.',
    );
  }

  let inflated;
  try {
    inflated = inflateRawSync(wire.subarray(headerEnd), {
      info: true,
      maxOutputLength,
    });
  } catch (cause) {
    throw new AuditResponseCompatibilityError(
      'npm audit response contained invalid or oversized gzip data.',
      { cause },
    );
  }

  const output = Buffer.from(inflated.buffer);
  const deflateBytes = inflated.engine.bytesWritten;
  const trailerOffset = headerEnd + deflateBytes;
  if (
    !Number.isSafeInteger(deflateBytes) ||
    deflateBytes <= 0 ||
    trailerOffset + 8 !== wire.length
  ) {
    throw new AuditResponseCompatibilityError(
      'npm audit response must contain exactly one complete gzip member.',
    );
  }

  const expectedCrc = wire.readUInt32LE(trailerOffset);
  const actualCrc = crc32(output) >>> 0;
  if (expectedCrc !== actualCrc) {
    throw new AuditResponseCompatibilityError('npm audit response failed its gzip CRC32 check.');
  }

  const expectedSize = wire.readUInt32LE(trailerOffset + 4);
  if (expectedSize !== output.length >>> 0) {
    throw new AuditResponseCompatibilityError('npm audit response failed its gzip size check.');
  }

  return output;
}

function parseGzipHeader(wire) {
  if (!startsWithGzipMagic(wire) || wire.length < 10) {
    throw new AuditResponseCompatibilityError(
      'npm audit response did not contain a complete gzip header.',
    );
  }

  const flags = wire[3];
  if ((flags & 0xe0) !== 0) {
    throw new AuditResponseCompatibilityError(
      'npm audit response used reserved gzip header flags.',
    );
  }

  let offset = 10;
  if ((flags & 0x04) !== 0) {
    requireGzipHeaderBytes(wire, offset, 2);
    const extraLength = wire.readUInt16LE(offset);
    offset += 2;
    requireGzipHeaderBytes(wire, offset, extraLength);
    offset += extraLength;
  }
  if ((flags & 0x08) !== 0) offset = findGzipHeaderTerminator(wire, offset);
  if ((flags & 0x10) !== 0) offset = findGzipHeaderTerminator(wire, offset);
  if ((flags & 0x02) !== 0) {
    requireGzipHeaderBytes(wire, offset, 2);
    const expectedHeaderCrc = wire.readUInt16LE(offset);
    const actualHeaderCrc = crc32(wire.subarray(0, offset)) & 0xffff;
    if (expectedHeaderCrc !== actualHeaderCrc) {
      throw new AuditResponseCompatibilityError(
        'npm audit response failed its gzip header CRC check.',
      );
    }
    offset += 2;
  }
  return offset;
}

function findGzipHeaderTerminator(wire, offset) {
  const terminator = wire.indexOf(0, offset);
  if (terminator < 0) {
    throw new AuditResponseCompatibilityError(
      'npm audit response contained a truncated gzip header field.',
    );
  }
  return terminator + 1;
}

function requireGzipHeaderBytes(wire, offset, length) {
  if (!Number.isSafeInteger(length) || length < 0 || offset + length > wire.length) {
    throw new AuditResponseCompatibilityError(
      'npm audit response contained a truncated gzip header.',
    );
  }
}

function startsWithGzipMagic(buffer) {
  return (
    buffer.length >= GZIP_MAGIC.length &&
    buffer[0] === GZIP_MAGIC[0] &&
    buffer[1] === GZIP_MAGIC[1] &&
    buffer[2] === GZIP_MAGIC[2]
  );
}

function validateAuditRequestBody(body) {
  if (!isRecord(body)) {
    throw new AuditResponseCompatibilityError('npm audit bulk request body must be an object.');
  }

  const packageNames = new Set();
  for (const [packageName, versions] of Object.entries(body)) {
    if (
      packageName.length === 0 ||
      !Array.isArray(versions) ||
      versions.length === 0 ||
      !versions.every((version) => typeof version === 'string' && version.length > 0)
    ) {
      throw new AuditResponseCompatibilityError(
        'npm audit bulk request body contained an invalid package entry.',
      );
    }
    packageNames.add(packageName);
  }
  if (packageNames.size === 0) {
    throw new AuditResponseCompatibilityError(
      'npm audit bulk request body did not contain any packages.',
    );
  }
  return packageNames;
}

function validateAuditResponseBody(body, expectedPackages) {
  if (!isRecord(body)) {
    throw new AuditResponseCompatibilityError('npm audit bulk response must be an object.');
  }

  for (const [packageName, advisories] of Object.entries(body)) {
    if (!expectedPackages.has(packageName)) {
      throw new AuditResponseCompatibilityError(
        `npm audit bulk response returned an unrequested package: ${packageName}.`,
      );
    }
    if (!Array.isArray(advisories) || !advisories.every(isRecord)) {
      throw new AuditResponseCompatibilityError(
        `npm audit bulk response returned invalid advisories for ${packageName}.`,
      );
    }
  }
}

function parseContentLength(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new AuditResponseCompatibilityError(
      'npm audit response returned an invalid Content-Length.',
    );
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length)) {
    throw new AuditResponseCompatibilityError(
      'npm audit response returned an unsafe Content-Length.',
    );
  }
  return length;
}

function validatePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

module.exports = {
  AUDIT_PATH,
  AUDIT_REGISTRY,
  AUDIT_URL,
  AuditResponseCompatibilityError,
  MAX_DECOMPRESSED_BYTES,
  MAX_READ_TIME_MS,
  MAX_WIRE_BYTES,
  createCompatibleRegistryFetch,
  isExactAuditRequest,
  isExactAuditResponse,
  parseAuditJsonBody,
  readBodyPrefix,
  readBodyWithLimit,
};
