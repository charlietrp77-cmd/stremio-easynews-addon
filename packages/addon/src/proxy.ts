import { Request, Response } from 'express';
import { Readable } from 'node:stream';
import os from 'node:os';
import { MultiChunkDownloader } from './multi-downloader.js';

interface CacheEntry {
  resolvedUrl: string;
  totalSize?: number;
  contentType?: string;
  expiresAt: number;
}

// In-memory cache for resolved CDN edge URLs and metadata
// Keyed by original target URL. TTL: 1 hour.
export const redirectCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;

// Minimum range size (2 MB) before engaging multi-connection downloader
const MULTI_CHUNK_THRESHOLD = 2 * 1024 * 1024;

/**
 * Find the primary local IPv4 address (e.g. 192.168.x.x or 10.x.x.x)
 * so local clients (Android TV, Apple TV) on the LAN can reach the addon.
 */
export function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/**
 * Returns the base URL for proxy requests.
 */
export function getProxyBaseUrl(customProxyHost?: string): string {
  if (customProxyHost && customProxyHost.trim()) {
    return customProxyHost.trim().replace(/\/+$/, '');
  }
  if (process.env.PROXY_URL && process.env.PROXY_URL.trim()) {
    return process.env.PROXY_URL.trim().replace(/\/+$/, '');
  }

  const port = process.env.PORT ?? '1337';
  const ip = getLocalIp();
  return `http://${ip}:${port}`;
}

/**
 * Formats a direct Easynews media URL into a proxied streaming URL.
 */
export function createProxiedStreamUrl(
  originalUrl: string,
  options?: { enableProxy?: string | boolean; proxyHost?: string }
): string {
  // If proxy is explicitly disabled in config, return original URL
  if (
    options?.enableProxy === false ||
    options?.enableProxy === 'false' ||
    process.env.ENABLE_LOCAL_PROXY === 'false'
  ) {
    return originalUrl;
  }

  const baseUrl = getProxyBaseUrl(options?.proxyHost);
  return `${baseUrl}/proxy/stream?url=${encodeURIComponent(originalUrl)}`;
}

/**
 * Extracts basic auth and target URL from an authenticated URL.
 */
export function extractAuthAndUrl(rawUrl: string): {
  cleanUrl: string;
  authHeader?: string;
} {
  const parsed = new URL(rawUrl);
  let authHeader: string | undefined;

  if (parsed.username || parsed.password) {
    const user = decodeURIComponent(parsed.username);
    const pass = decodeURIComponent(parsed.password);
    authHeader = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
    parsed.username = '';
    parsed.password = '';
  }

  return { cleanUrl: parsed.toString(), authHeader };
}

export interface ResolvedMetadata {
  resolvedUrl: string;
  totalSize?: number;
  contentType?: string;
}

/**
 * Resolves the Easynews 302/307 edge redirect JIT and retrieves metadata.
 * Issues a manual HEAD request to extract the pre-signed ?sig= edge CDN URL.
 */
export async function resolveDirectUrlWithMeta(
  targetUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<ResolvedMetadata> {
  const cached = redirectCache.get(targetUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      resolvedUrl: cached.resolvedUrl,
      totalSize: cached.totalSize,
      contentType: cached.contentType,
    };
  }

  const { cleanUrl, authHeader } = extractAuthAndUrl(targetUrl);

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  };
  if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  const res = await fetchFn(cleanUrl, {
    method: 'HEAD',
    headers,
    redirect: 'manual',
  });

  const location = res.headers.get('location');
  const contentLength = res.headers.get('content-length');
  const contentType = res.headers.get('content-type') || undefined;
  const totalSize = contentLength ? parseInt(contentLength, 10) : undefined;

  let resolvedUrl = targetUrl;
  if (res.status >= 300 && res.status < 400 && location) {
    resolvedUrl = new URL(location, cleanUrl).toString();
  } else if (res.status === 200) {
    resolvedUrl = targetUrl;
  } else if (res.status === 401 || res.status === 403) {
    throw new Error(`Easynews authentication failed with status ${res.status}`);
  }

  redirectCache.set(targetUrl, {
    resolvedUrl,
    totalSize,
    contentType,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return { resolvedUrl, totalSize, contentType };
}

export async function resolveDirectUrl(
  targetUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const meta = await resolveDirectUrlWithMeta(targetUrl, fetchFn);
  return meta.resolvedUrl;
}

/**
 * Creates an Express request handler for proxying streaming media requests.
 * Uses Phase 3 MultiChunkDownloader for high throughput 4K Remux playback.
 */
export function createProxyHandler(fetchFn: typeof fetch = fetch) {
  return async function proxyStreamHandler(
    req: Request,
    res: Response
  ): Promise<void> {
    const targetUrl = req.query.url as string | undefined;

    if (!targetUrl) {
      res.status(400).send('Missing "url" query parameter');
      return;
    }

    try {
      const meta = await resolveDirectUrlWithMeta(targetUrl, fetchFn);
      const { cleanUrl, authHeader } = extractAuthAndUrl(meta.resolvedUrl);

      const forwardHeaders: Record<string, string> = {
        'User-Agent':
          (req.headers['user-agent'] as string) ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };

      if (authHeader) {
        forwardHeaders['Authorization'] = authHeader;
      } else {
        const originalAuth = extractAuthAndUrl(targetUrl).authHeader;
        if (originalAuth) {
          forwardHeaders['Authorization'] = originalAuth;
        }
      }

      // Always ensure CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Accept-Ranges', 'bytes');

      const isHead = req.method === 'HEAD';

      // Parse Range header if present
      const rangeHeader = req.headers.range as string | undefined;
      let startByte = 0;
      let endByte = meta.totalSize ? meta.totalSize - 1 : undefined;
      let isRange = false;

      if (rangeHeader) {
        const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
        if (matches) {
          isRange = true;
          startByte = parseInt(matches[1], 10);
          if (matches[2]) {
            endByte = parseInt(matches[2], 10);
          } else if (meta.totalSize) {
            endByte = meta.totalSize - 1;
          }
        }
      }

      // If HEAD request, respond with metadata headers
      if (isHead) {
        if (meta.contentType) {
          res.setHeader('Content-Type', meta.contentType);
        }
        if (isRange && endByte !== undefined && meta.totalSize) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${startByte}-${endByte}/${meta.totalSize}`);
          res.setHeader('Content-Length', (endByte - startByte + 1).toString());
        } else if (meta.totalSize) {
          res.status(200);
          res.setHeader('Content-Length', meta.totalSize.toString());
        } else {
          res.status(200);
        }
        res.end();
        return;
      }

      const requestedSpan =
        endByte !== undefined ? endByte - startByte + 1 : undefined;

      // Phase 3: Check if we can use MultiChunkDownloader
      // Applicable if we have known total size and requested span > threshold
      const enableMultiChunk =
        process.env.ENABLE_MULTI_CHUNK !== 'false' &&
        meta.totalSize !== undefined &&
        endByte !== undefined &&
        requestedSpan !== undefined &&
        requestedSpan >= MULTI_CHUNK_THRESHOLD;

      if (enableMultiChunk && meta.totalSize && endByte !== undefined) {
        // Multi-connection chunk streaming (Phase 3)
        const concurrency = +(process.env.CONCURRENT_CHUNKS ?? 4);
        const chunkSize = +(process.env.CHUNK_SIZE_MB ?? 4) * 1024 * 1024;
        const maxBufferChunks = +(process.env.MAX_BUFFER_CHUNKS ?? 12);

        res.status(isRange ? 206 : 200);
        if (meta.contentType) {
          res.setHeader('Content-Type', meta.contentType);
        }
        if (isRange) {
          res.setHeader(
            'Content-Range',
            `bytes ${startByte}-${endByte}/${meta.totalSize}`
          );
        }
        res.setHeader('Content-Length', (endByte - startByte + 1).toString());

        const downloader = new MultiChunkDownloader({
          resolvedUrl: cleanUrl,
          forwardHeaders,
          startByte,
          endByte,
          totalSize: meta.totalSize,
          chunkSize,
          concurrency,
          maxBufferChunks,
          fetchFn,
        });

        downloader.pipe(res);
        return;
      }

      // Fallback: Single-stream request (for small probes or when total size unknown)
      if (rangeHeader) {
        forwardHeaders['Range'] = rangeHeader;
      }

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      const upstreamRes = await fetchFn(cleanUrl, {
        method: 'GET',
        headers: forwardHeaders,
        redirect: 'follow',
        signal: abortController.signal,
      });

      res.status(upstreamRes.status);

      const headersToForward = [
        'content-type',
        'content-length',
        'content-range',
        'accept-ranges',
        'content-disposition',
        'last-modified',
        'etag',
      ];

      for (const header of headersToForward) {
        const val = upstreamRes.headers.get(header);
        if (val) {
          res.setHeader(header, val);
        }
      }

      if (!upstreamRes.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(upstreamRes.body as any);
      nodeStream.on('error', (err: any) => {
        if (err.name !== 'AbortError') {
          console.error('Proxy single-stream pipeline error:', err);
        }
      });

      nodeStream.pipe(res);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return;
      }
      console.error('Proxy stream failed:', error);
      if (!res.headersSent) {
        res.status(502).send(`Proxy streaming error: ${error.message}`);
      }
    }
  };
}

export const proxyStreamHandler = createProxyHandler();
