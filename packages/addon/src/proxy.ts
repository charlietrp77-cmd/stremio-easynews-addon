import { Request, Response } from 'express';
import { Readable } from 'node:stream';
import os from 'node:os';
import { MultiChunkDownloader } from './multi-downloader.js';

interface CacheEntry {
  resolvedUrl: string;
  expiresAt: number;
}

// In-memory cache for resolved CDN edge URLs
// Keyed by original target URL. TTL: 1 hour.
export const redirectCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 60 * 1000;

// Minimum range size (2 MB) before engaging multi-connection downloader
const MULTI_CHUNK_THRESHOLD = 2 * 1024 * 1024;

/**
 * Returns the proper video MIME type based on filename or URL.
 * ExoPlayer strictly requires a valid video MIME type or file extension to instantiate extractors.
 */
export function getMimeType(urlOrFilename: string): string {
  const lower = urlOrFilename.toLowerCase();
  if (lower.includes('.mp4') || lower.includes('.m4v')) return 'video/mp4';
  if (lower.includes('.avi')) return 'video/x-msvideo';
  if (lower.includes('.webm')) return 'video/webm';
  if (lower.includes('.ts')) return 'video/mp2t';
  if (lower.includes('.mov')) return 'video/quicktime';
  return 'video/x-matroska';
}

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
 * Includes the safe filename in the path so ExoPlayer can detect the container (.mkv/.mp4).
 */
export function createProxiedStreamUrl(
  originalUrl: string,
  options?: { enableProxy?: string | boolean; proxyHost?: string },
  fileName?: string
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

  let safeName = 'video.mkv';
  if (fileName) {
    safeName = encodeURIComponent(fileName);
  } else {
    try {
      const parsed = new URL(originalUrl);
      const parts = parsed.pathname.split('/');
      const last = parts[parts.length - 1];
      if (last) safeName = encodeURIComponent(last);
    } catch {
      // fallback
    }
  }

  return `${baseUrl}/proxy/stream/${safeName}?url=${encodeURIComponent(originalUrl)}`;
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

/**
 * Resolves the Easynews 302/307 edge redirect JIT.
 * Issues a manual HEAD request to extract the pre-signed ?sig= edge CDN URL.
 */
export async function resolveDirectUrl(
  targetUrl: string,
  fetchFn: typeof fetch = fetch
): Promise<string> {
  const cached = redirectCache.get(targetUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.resolvedUrl;
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
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return resolvedUrl;
}

/**
 * Creates an Express request handler for proxying streaming media requests.
 * Fully compatible with ExoPlayer / Stremio on Android TV.
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
      const resolvedUrl = await resolveDirectUrl(targetUrl, fetchFn);
      const { cleanUrl, authHeader } = extractAuthAndUrl(resolvedUrl);

      const mimeType = getMimeType(targetUrl);

      // Setup headers for upstream edge server
      const forwardHeaders: Record<string, string> = {
        'User-Agent':
          (req.headers['user-agent'] as string) ||
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      };

      if (req.headers.range) {
        forwardHeaders['Range'] = req.headers.range as string;
      }

      // If resolvedUrl still has auth credentials, forward them
      if (authHeader) {
        forwardHeaders['Authorization'] = authHeader;
      } else {
        const originalAuth = extractAuthAndUrl(targetUrl).authHeader;
        if (originalAuth) {
          forwardHeaders['Authorization'] = originalAuth;
        }
      }

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      const isHead = req.method === 'HEAD';

      // Request edge server directly with player method and headers
      const upstreamRes = await fetchFn(cleanUrl, {
        method: isHead ? 'HEAD' : 'GET',
        headers: forwardHeaders,
        redirect: 'follow',
        signal: abortController.signal,
      });

      if (upstreamRes.status >= 400) {
        console.error(`[Proxy] Upstream edge returned error status ${upstreamRes.status}`);
        if (!res.headersSent) {
          res.status(upstreamRes.status).send(`Upstream edge error: ${upstreamRes.statusText}`);
        }
        return;
      }

      res.status(upstreamRes.status);

      // CRITICAL FOR EXOPLAYER:
      // Ensure Content-Type is NEVER null, empty, or text/html.
      let upstreamContentType = upstreamRes.headers.get('content-type');
      if (
        !upstreamContentType ||
        upstreamContentType.includes('text/html') ||
        upstreamContentType.includes('text/plain') ||
        upstreamContentType.includes('application/octet-stream')
      ) {
        upstreamContentType = mimeType;
      }
      res.setHeader('Content-Type', upstreamContentType);

      // Forward Content-Length
      const contentLength = upstreamRes.headers.get('content-length');
      if (contentLength) {
        res.setHeader('Content-Length', contentLength);
      }

      // Forward Content-Range
      const contentRange = upstreamRes.headers.get('content-range');
      if (contentRange) {
        res.setHeader('Content-Range', contentRange);
      }

      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Type, Content-Length, Content-Range, Accept-Ranges'
      );

      if (isHead || !upstreamRes.body) {
        res.end();
        return;
      }

      // Check if MultiChunkDownloader should be engaged for open-ended range playback
      let totalSizeFromRange: number | undefined;
      if (contentRange) {
        const parts = contentRange.match(/\/(\d+)$/);
        if (parts && parts[1]) {
          totalSizeFromRange = parseInt(parts[1], 10);
        }
      }

      const isMultiChunkEnabled =
        process.env.ENABLE_MULTI_CHUNK === 'true' &&
        totalSizeFromRange !== undefined &&
        totalSizeFromRange > MULTI_CHUNK_THRESHOLD &&
        req.headers.range &&
        req.headers.range.endsWith('-');

      if (isMultiChunkEnabled && totalSizeFromRange) {
        const startMatch = req.headers.range!.match(/bytes=(\d+)-/);
        const startByte = startMatch ? parseInt(startMatch[1], 10) : 0;
        const endByte = totalSizeFromRange - 1;

        const downloader = new MultiChunkDownloader({
          resolvedUrl: cleanUrl,
          forwardHeaders,
          startByte,
          endByte,
          totalSize: totalSizeFromRange,
          chunkSize: +(process.env.CHUNK_SIZE_MB ?? 4) * 1024 * 1024,
          concurrency: +(process.env.CONCURRENT_CHUNKS ?? 4),
          maxBufferChunks: +(process.env.MAX_BUFFER_CHUNKS ?? 12),
          fetchFn,
        });

        downloader.pipe(res);
        return;
      }

      // High-performance single-stream pipe directly from upstream CDN
      const nodeStream = Readable.fromWeb(upstreamRes.body as any);
      nodeStream.on('error', (err: any) => {
        if (err.name !== 'AbortError') {
          console.error('[Proxy] Stream pipeline error:', err);
        }
      });

      nodeStream.pipe(res);
    } catch (error: any) {
      if (error.name === 'AbortError') {
        return;
      }
      console.error('[Proxy] Stream failed:', error);
      if (!res.headersSent) {
        res.status(502).send(`Proxy streaming error: ${error.message}`);
      }
    }
  };
}

export const proxyStreamHandler = createProxyHandler();
