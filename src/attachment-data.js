import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { constants, createReadStream } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';

const MIB = 1024 * 1024;
const TYPES = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.mp4', 'video/mp4'], ['.mov', 'video/quicktime'], ['.webm', 'video/webm'],
]);
const EXTENSIONS = new Map([...TYPES].map(([extension, contentType]) => [contentType, extension]));
EXTENSIONS.set('image/jpeg', '.jpg');
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const PRIVATE = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) PRIVATE.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  PRIVATE.addSubnet(address, prefix, 'ipv6');
}
const GLOBAL_V6 = new BlockList();
GLOBAL_V6.addSubnet('2000::', 3, 'ipv6');

export class AttachmentDataError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AttachmentDataError';
    this.code = code;
  }
}

const failure = (message, code) => new AttachmentDataError(message, code);

/** Conservative public-address check; excludes translation and special-use ranges. */
export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !PRIVATE.check(address, 'ipv4');
  return family === 6 && GLOBAL_V6.check(address, 'ipv6') && !PRIVATE.check(address, 'ipv6');
}

function cleanName(value) {
  const safe = value.replace(/[\x00-\x1f\x7f/\\]/g, '_') || 'attachment';
  const extension = path.extname(safe);
  return safe.length <= 240 ? safe : safe.slice(0, 240 - extension.length) + extension;
}

function mediaInfo(name, responseType) {
  let extension = path.extname(name).toLowerCase();
  const receivedType = responseType?.split(';', 1)[0].trim().toLowerCase();
  if (!extension && receivedType && EXTENSIONS.has(receivedType)) {
    extension = EXTENSIONS.get(receivedType);
    name += extension;
  }
  const contentType = TYPES.get(extension);
  if (!contentType) {
    throw failure('Unsupported attachment type. Use PNG, JPG/JPEG, GIF, WEBP, SVG, MP4, MOV, or WEBM.', 'UNSUPPORTED_TYPE');
  }
  if (receivedType && receivedType !== 'application/octet-stream' && receivedType !== contentType) {
    throw failure('Remote attachment Content-Type does not match its supported media extension.', 'CONTENT_TYPE_MISMATCH');
  }
  return { name: cleanName(name), contentType, maxBytes: contentType.startsWith('image/') ? 10 * MIB : 100 * MIB };
}

function limitFor(media, options) {
  return Math.min(media.maxBytes, options.maxBytes ?? media.maxBytes);
}

function matchesMedia(prefix, contentType) {
  switch (contentType) {
    case 'image/png': return prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    case 'image/jpeg': return prefix.length >= 3 && prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255;
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString('ascii'));
    case 'image/webp': return prefix.subarray(0, 4).toString('ascii') === 'RIFF' && prefix.subarray(8, 12).toString('ascii') === 'WEBP';
    case 'image/svg+xml': {
      const start = prefix.toString('utf8').replace(/^\uFEFF/, '').trimStart()
        .replace(/^<\?xml\b[^]*?\?>\s*/, '').replace(/^(?:<!--[^]*?-->\s*)*/, '')
        .replace(/^<!DOCTYPE\s+svg\b(?:[^>\[]|\[[^]*?\])*>\s*/, '');
      return /^<svg(?:\s|>)/.test(start);
    }
    case 'video/mp4': return prefix.subarray(4, 8).toString('ascii') === 'ftyp';
    case 'video/quicktime': return ['ftyp', 'moov', 'mdat', 'wide', 'free', 'pnot', 'skip'].includes(prefix.subarray(4, 8).toString('ascii'));
    case 'video/webm': return prefix.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]));
    default: return false;
  }
}

async function snapshot(source, media, options, { inspectMedia = false } = {}) {
  const maximum = limitFor(media, options);
  const digest = createHash('sha256');
  let size = 0;
  let chunks = [];
  let prefix = Buffer.alloc(0);
  let directory;
  let handle;
  let filename;
  try {
    for await (const part of source) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > maximum) throw failure(`Attachment exceeds the ${maximum}-byte limit for this media type.`, 'TOO_LARGE');
      digest.update(chunk);
      if (inspectMedia && prefix.length < 65536) prefix = Buffer.concat([prefix, chunk.subarray(0, 65536 - prefix.length)]);
      if (!handle && size > options.memoryLimitBytes) {
        directory = await mkdtemp(path.join(options.tempRoot, 'gh-comment-attachment-'));
        await chmod(directory, 0o700);
        filename = path.join(directory, 'snapshot');
        handle = await open(filename, 'wx', 0o600);
        for (const buffered of chunks) await handle.writeFile(buffered);
        chunks = [];
      }
      if (handle) await handle.writeFile(chunk);
      else chunks.push(Buffer.from(chunk));
    }
    if (size === 0) throw failure('Attachment is empty.', 'EMPTY_FILE');
    if (inspectMedia && !matchesMedia(prefix, media.contentType)) {
      throw failure('Remote attachment bytes do not match the declared media type.', 'INVALID_MEDIA');
    }
    await handle?.close();
    handle = undefined;
    let bytes = directory ? undefined : Buffer.concat(chunks, size);
    chunks = [];
    let disposed = false;
    const streams = new Set();
    return {
      name: media.name,
      contentType: media.contentType,
      size,
      sha256: digest.digest('hex'),
      storage: directory ? 'disk' : 'memory',
      openBody() {
        if (disposed) throw failure('Attachment snapshot has already been disposed.', 'DISPOSED');
        if (bytes) return Buffer.from(bytes);
        const stream = createReadStream(filename);
        streams.add(stream);
        stream.once('close', () => streams.delete(stream));
        // Disposal may happen before a consumer starts reading the stream.
        stream.on('error', () => {});
        return stream;
      },
      async dispose() {
        if (disposed) return;
        disposed = true;
        bytes = undefined;
        const pending = [...streams].map(stream => finished(stream).catch(() => {}));
        for (const stream of streams) stream.destroy();
        await Promise.all(pending);
        if (directory) await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function remoteURL(source) {
  let url;
  try { url = new URL(source); } catch { throw failure('Remote attachment URL is invalid.', 'INVALID_URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw failure('Remote attachments require an HTTP or HTTPS URL.', 'INVALID_URL');
  if (url.username || url.password) throw failure('Attachment URLs must not contain embedded credentials.', 'URL_CREDENTIALS');
  url.hash = '';
  return url;
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(failure('Remote attachment download exceeded its deadline.', 'TIMEOUT'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function resolveAddress(url, options, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(hostname);
  const addresses = literal ? [{ address: hostname, family: literal }]
    : await abortable(options.lookup(hostname, { all: true, verbatim: true }), signal);
  if (!Array.isArray(addresses) || addresses.length === 0
    || addresses.some(entry => !isIP(entry.address) || isIP(entry.address) !== entry.family)) {
    throw failure('Remote attachment hostname did not resolve to a usable address.', 'DNS_ERROR');
  }
  if (!options.allowPrivateNetwork && addresses.some(entry => !isPublicAddress(entry.address))) {
    throw failure('Remote attachments may only use public network addresses. Explicitly allow private networks to download a trusted LAN attachment.', 'PRIVATE_NETWORK');
  }
  return addresses[0];
}

function request(url, address, signal) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const req = client.get(url, {
      agent: false,
      signal,
      family: address.family,
      autoSelectFamily: false,
      maxHeaderSize: 16384,
      // Pin the checked address, retaining the original Host and TLS identity.
      lookup(_hostname, options, callback) {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: { Accept: 'image/*, video/*', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'github-comment-cli' },
    }, resolve);
    req.once('error', reject);
  });
}

async function prepareRemote(source, options) {
  if (!options.downloadRemote) throw failure('Remote attachments require explicit download permission.', 'REMOTE_DISABLED');
  let url = remoteURL(source);
  let name;
  try { name = cleanName(path.posix.basename(decodeURIComponent(url.pathname)) || 'attachment'); }
  catch { throw failure('Remote attachment path has invalid URL encoding.', 'INVALID_URL'); }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response;
  let result;
  try {
    for (let redirects = 0; ; redirects += 1) {
      const address = await resolveAddress(url, options, controller.signal);
      response = await options.requestImpl(url, address, controller.signal);
      if (!REDIRECTS.has(response.statusCode)) break;
      const location = response.headers.location;
      response.destroy();
      if (redirects >= options.maxRedirects) throw failure('Remote attachment exceeded its redirect limit.', 'TOO_MANY_REDIRECTS');
      if (!location) throw failure('Remote attachment redirect has no destination.', 'INVALID_REDIRECT');
      let next;
      try { next = remoteURL(new URL(location, url).href); }
      catch (error) {
        if (error instanceof AttachmentDataError) throw error;
        throw failure('Remote attachment redirect is invalid.', 'INVALID_REDIRECT');
      }
      if (url.protocol === 'https:' && next.protocol !== 'https:') {
        throw failure('HTTPS attachments cannot redirect to an insecure HTTP connection.', 'INSECURE_REDIRECT');
      }
      url = next;
    }
    if (response.statusCode !== 200) throw failure(`Remote attachment request failed (HTTP ${response.statusCode}).`, 'HTTP_ERROR');
    const media = mediaInfo(name, response.headers['content-type']);
    const maximum = limitFor(media, options);
    const contentLength = response.headers['content-length'];
    if (contentLength !== undefined && (!/^\d+$/.test(contentLength) || Number(contentLength) > maximum)) {
      throw failure(`Remote attachment Content-Length exceeds the ${maximum}-byte limit.`, 'TOO_LARGE');
    }
    let received = 0;
    const wireLimit = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length;
      callback(received > maximum ? failure(`Remote attachment exceeds the ${maximum}-byte download limit.`, 'TOO_LARGE') : null, chunk);
    } });
    const encoding = response.headers['content-encoding']?.trim().toLowerCase() ?? 'identity';
    const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
      : encoding === 'br' ? createBrotliDecompress() : undefined;
    if (encoding !== 'identity' && !decoder) throw failure('Remote attachment uses an unsupported Content-Encoding.', 'UNSUPPORTED_ENCODING');
    await pipeline(response, wireLimit, ...(decoder ? [decoder] : []), async chunks => {
      result = await snapshot(chunks, media, options, { inspectMedia: true });
    }, { signal: controller.signal });
    if (contentLength !== undefined && received !== Number(contentLength)) {
      throw failure('Remote attachment length did not match its declared Content-Length.', 'INCOMPLETE_DOWNLOAD');
    }
    return result;
  } catch (error) {
    await result?.dispose();
    if (controller.signal.aborted) throw failure('Remote attachment download exceeded its deadline.', 'TIMEOUT');
    if (error instanceof AttachmentDataError) throw error;
    // Do not leak signed query strings, URL userinfo, or server error bodies.
    throw failure('Remote attachment could not be downloaded completely.', 'DOWNLOAD_FAILED');
  } finally {
    clearTimeout(timer);
    response?.destroy();
  }
}

/** Snapshot attachment bytes before any upload; dispose the result in a finally block. */
export async function prepareAttachment(source, {
  baseDir = process.cwd(), downloadRemote = false, memoryLimitBytes = 8 * MIB,
  maxBytes, allowPrivateNetwork = false, timeoutMs = 30000, maxRedirects = 5,
  lookup = dnsLookup, tempRoot = os.tmpdir(), requestImpl = request,
} = {}) {
  if (typeof source !== 'string' || !source) throw failure('Attachment source must be a nonempty path or URL.', 'INVALID_SOURCE');
  if (typeof downloadRemote !== 'boolean' || typeof allowPrivateNetwork !== 'boolean') {
    throw failure('Attachment network permissions must be explicit boolean values.', 'INVALID_OPTION');
  }
  for (const [key, value, minimum] of [['memoryLimitBytes', memoryLimitBytes, 0], ['maxBytes', maxBytes ?? 1, 1], ['timeoutMs', timeoutMs, 1], ['maxRedirects', maxRedirects, 0]]) {
    if (!Number.isSafeInteger(value) || value < minimum || (key === 'timeoutMs' && value > 2147483647)) {
      throw failure(`Invalid attachment option: ${key}.`, 'INVALID_OPTION');
    }
  }
  const options = { memoryLimitBytes, maxBytes, allowPrivateNetwork, downloadRemote, timeoutMs, maxRedirects, lookup, tempRoot, requestImpl };
  if (/^https?:/i.test(source)) return prepareRemote(source, options);
  let filename;
  try {
    if (/^file:/i.test(source)) filename = fileURLToPath(source);
    else if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) throw new Error('Unsupported URL');
    else filename = path.resolve(baseDir, source);
  } catch { throw failure('Attachment source is not a valid local file path or supported URL.', 'INVALID_SOURCE'); }
  const media = mediaInfo(path.basename(filename));
  let handle;
  try {
    // NONBLOCK prevents a named pipe from hanging before fstat can reject it.
    handle = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) throw failure('Local attachment must be a regular file, not a directory or device.', 'NOT_REGULAR_FILE');
    if (info.size === 0) throw failure('Attachment is empty.', 'EMPTY_FILE');
    if (info.size > limitFor(media, options)) throw failure(`Attachment exceeds the ${limitFor(media, options)}-byte limit for this media type.`, 'TOO_LARGE');
    return await snapshot(handle.createReadStream({ autoClose: false }), media, options);
  } catch (error) {
    if (error instanceof AttachmentDataError) throw error;
    throw failure('Local attachment could not be read as a regular file.', 'FILE_READ_FAILED');
  } finally {
    await handle?.close();
  }
}
