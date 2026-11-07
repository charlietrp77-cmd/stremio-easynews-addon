import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  extractAuthAndUrl,
  getProxyBaseUrl,
  createProxiedStreamUrl,
  resolveDirectUrlWithMeta,
  redirectCache,
  createProxyHandler,
} from './proxy.js';

describe('Proxy Module (Phase 2 & Phase 3)', () => {
  beforeEach(() => {
    redirectCache.clear();
    delete process.env.PROXY_URL;
    delete process.env.ENABLE_LOCAL_PROXY;
    delete process.env.ENABLE_MULTI_CHUNK;
  });

  describe('extractAuthAndUrl', () => {
    it('should extract credentials and format Basic auth', () => {
      const { cleanUrl, authHeader } = extractAuthAndUrl(
        'https://myuser:mypass@members.easynews.com/dl/farm/port/file.mkv'
      );
      expect(cleanUrl).toBe(
        'https://members.easynews.com/dl/farm/port/file.mkv'
      );
      expect(authHeader).toBe('Basic bXl1c2VyOm15cGFzcw==');
    });

    it('should handle URL without credentials', () => {
      const { cleanUrl, authHeader } = extractAuthAndUrl(
        'https://ams-dl-01.easynews.com/dl/farm/port/file.mkv?sig=123'
      );
      expect(cleanUrl).toBe(
        'https://ams-dl-01.easynews.com/dl/farm/port/file.mkv?sig=123'
      );
      expect(authHeader).toBeUndefined();
    });
  });

  describe('getProxyBaseUrl & createProxiedStreamUrl', () => {
    it('should use custom proxy host when provided', () => {
      const url = createProxiedStreamUrl('https://example.com/stream.mkv', {
        proxyHost: 'http://192.168.1.55:9000',
      });
      expect(url).toBe(
        'http://192.168.1.55:9000/proxy/stream?url=https%3A%2F%2Fexample.com%2Fstream.mkv'
      );
    });

    it('should use PROXY_URL env var if available', () => {
      process.env.PROXY_URL = 'http://lan-server:1337';
      const url = createProxiedStreamUrl('https://example.com/stream.mkv');
      expect(url).toBe(
        'http://lan-server:1337/proxy/stream?url=https%3A%2F%2Fexample.com%2Fstream.mkv'
      );
    });

    it('should bypass proxy when enableProxy is false', () => {
      const direct = 'https://members.easynews.com/dl/test.mkv';
      const res = createProxiedStreamUrl(direct, { enableProxy: false });
      expect(res).toBe(direct);
    });
  });

  describe('resolveDirectUrlWithMeta (JIT Redirect Resolution)', () => {
    it('should issue HEAD request and extract edge redirect and content metadata', async () => {
      const directUrl =
        'https://myuser:mypass@members.easynews.com/dl/farm/port/file.mkv';
      const edgeUrl =
        'https://ams-dl-01.easynews.com/dl/farm/port/file.mkv?sig=abcdef123';

      const mockFetch = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({
          location: edgeUrl,
          'content-length': '50000000000',
          'content-type': 'video/x-matroska',
        }),
      });

      const meta = await resolveDirectUrlWithMeta(directUrl, mockFetch as any);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://members.easynews.com/dl/farm/port/file.mkv',
        expect.objectContaining({
          method: 'HEAD',
          headers: expect.objectContaining({
            Authorization: 'Basic bXl1c2VyOm15cGFzcw==',
          }),
          redirect: 'manual',
        })
      );
      expect(meta.resolvedUrl).toBe(edgeUrl);
      expect(meta.totalSize).toBe(50000000000);
      expect(meta.contentType).toBe('video/x-matroska');
    });

    it('should throw on authentication failure (401)', async () => {
      const directUrl = 'https://wrong:creds@members.easynews.com/dl/test.mkv';
      const mockFetch = vi.fn().mockResolvedValue({
        status: 401,
        headers: new Headers(),
      });

      await expect(
        resolveDirectUrlWithMeta(directUrl, mockFetch as any)
      ).rejects.toThrow(/authentication failed with status 401/);
    });
  });

  describe('createProxyHandler', () => {
    it('should return 400 if url query parameter is missing', async () => {
      const handler = createProxyHandler();
      const req: any = { query: {} };
      const res: any = {
        status: vi.fn().mockReturnThis(),
        send: vi.fn(),
      };

      await handler(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.send).toHaveBeenCalledWith('Missing "url" query parameter');
    });

    it('should handle small range probe requests with single-stream fetch', async () => {
      const directUrl =
        'https://user:pass@members.easynews.com/dl/farm/port/movie.mkv';
      const edgeUrl =
        'https://ams-dl-01.easynews.com/dl/farm/port/movie.mkv?sig=xyz';

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('probe chunk'));
          controller.close();
        },
      });

      const mockFetch = vi
        .fn()
        // 1st call: HEAD metadata
        .mockResolvedValueOnce({
          status: 302,
          headers: new Headers({
            location: edgeUrl,
            'content-length': '1000',
            'content-type': 'video/mp4',
          }),
        })
        // 2nd call: GET probe stream
        .mockResolvedValueOnce({
          status: 206,
          headers: new Headers({
            'content-type': 'video/mp4',
            'content-length': '11',
            'content-range': 'bytes 0-10/1000',
            'accept-ranges': 'bytes',
          }),
          body: stream,
        });

      const handler = createProxyHandler(mockFetch as any);

      const req: any = {
        method: 'GET',
        query: { url: directUrl },
        headers: { range: 'bytes=0-10' },
      };

      const setHeaders: Record<string, string> = {};
      const res: any = new PassThrough();
      res.status = vi.fn().mockReturnThis();
      res.setHeader = vi.fn((k: string, v: string) => {
        setHeaders[k.toLowerCase()] = v;
      });
      res.getHeader = vi.fn((k: string) => setHeaders[k.toLowerCase()]);
      res.send = vi.fn();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(206);
      expect(setHeaders['content-type']).toBe('video/mp4');
      expect(setHeaders['content-range']).toBe('bytes 0-10/1000');
    });

    it('should engage MultiChunkDownloader for high-bitrate streaming requests', async () => {
      const directUrl =
        'https://user:pass@members.easynews.com/dl/farm/port/4k_remux.mkv';
      const edgeUrl =
        'https://ams-dl-01.easynews.com/dl/farm/port/4k_remux.mkv?sig=xyz';

      const mockFetch = vi
        .fn()
        // 1st call: HEAD metadata
        .mockResolvedValueOnce({
          status: 302,
          headers: new Headers({
            location: edgeUrl,
            'content-length': '50000000000', // 50 GB
            'content-type': 'video/x-matroska',
          }),
        })
        // Multi-chunk GET range requests
        .mockImplementation((url: string, opts: any) => {
          return Promise.resolve({
            ok: true,
            status: 206,
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(1024)),
          });
        });

      const handler = createProxyHandler(mockFetch as any);

      const req: any = {
        method: 'GET',
        query: { url: directUrl },
        headers: { range: 'bytes=0-' },
      };

      const setHeaders: Record<string, string> = {};
      const res: any = new PassThrough();
      res.status = vi.fn().mockReturnThis();
      res.setHeader = vi.fn((k: string, v: string) => {
        setHeaders[k.toLowerCase()] = v;
      });
      res.getHeader = vi.fn((k: string) => setHeaders[k.toLowerCase()]);
      res.write = vi.fn().mockReturnValue(true);
      res.end = vi.fn();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(206);
      expect(setHeaders['content-type']).toBe('video/x-matroska');
      expect(setHeaders['content-range']).toBe('bytes 0-49999999999/50000000000');
      expect(setHeaders['content-length']).toBe('50000000000');
    });
  });
});
