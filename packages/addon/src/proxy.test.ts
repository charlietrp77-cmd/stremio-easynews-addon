import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  extractAuthAndUrl,
  getProxyBaseUrl,
  createProxiedStreamUrl,
  resolveDirectUrl,
  redirectCache,
  createProxyHandler,
  getMimeType,
} from './proxy.js';

describe('Proxy Module (ExoPlayer & Streaming Fixes)', () => {
  beforeEach(() => {
    redirectCache.clear();
    delete process.env.PROXY_URL;
    delete process.env.ENABLE_LOCAL_PROXY;
    delete process.env.ENABLE_MULTI_CHUNK;
  });

  describe('getMimeType', () => {
    it('should infer video/x-matroska for .mkv', () => {
      expect(getMimeType('Movie.Title.2024.2160p.mkv')).toBe('video/x-matroska');
    });

    it('should infer video/mp4 for .mp4', () => {
      expect(getMimeType('Video.mp4')).toBe('video/mp4');
    });
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
    it('should append filename to path and use custom proxy host', () => {
      const url = createProxiedStreamUrl('https://example.com/stream.mkv', {
        proxyHost: 'http://192.168.1.55:9000',
      });
      expect(url).toBe(
        'http://192.168.1.55:9000/proxy/stream/stream.mkv?url=https%3A%2F%2Fexample.com%2Fstream.mkv'
      );
    });

    it('should use explicit filename when passed', () => {
      const url = createProxiedStreamUrl(
        'https://example.com/stream',
        { proxyHost: 'http://192.168.1.55:9000' },
        'Custom Movie.mkv'
      );
      expect(url).toBe(
        'http://192.168.1.55:9000/proxy/stream/Custom%20Movie.mkv?url=https%3A%2F%2Fexample.com%2Fstream'
      );
    });

    it('should use PROXY_URL env var if available', () => {
      process.env.PROXY_URL = 'http://lan-server:1337';
      const url = createProxiedStreamUrl('https://example.com/stream.mkv');
      expect(url).toBe(
        'http://lan-server:1337/proxy/stream/stream.mkv?url=https%3A%2F%2Fexample.com%2Fstream.mkv'
      );
    });

    it('should bypass proxy when enableProxy is false', () => {
      const direct = 'https://members.easynews.com/dl/test.mkv';
      const res = createProxiedStreamUrl(direct, { enableProxy: false });
      expect(res).toBe(direct);
    });
  });

  describe('resolveDirectUrl', () => {
    it('should extract location from 302 and cache it', async () => {
      const directUrl =
        'https://myuser:mypass@members.easynews.com/dl/farm/port/file.mkv';
      const edgeUrl =
        'https://ams-dl-01.easynews.com/dl/farm/port/file.mkv?sig=abcdef123';

      const mockFetch = vi.fn().mockResolvedValue({
        status: 302,
        headers: new Headers({
          location: edgeUrl,
        }),
      });

      const resolved = await resolveDirectUrl(directUrl, mockFetch as any);
      expect(resolved).toBe(edgeUrl);
    });
  });

  describe('createProxyHandler (ExoPlayer Headers)', () => {
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

    it('should forward HEAD requests with video Content-Type for ExoPlayer', async () => {
      const directUrl =
        'https://user:pass@members.easynews.com/dl/farm/port/movie.mkv';
      const edgeUrl =
        'https://ams-dl-01.easynews.com/dl/farm/port/movie.mkv?sig=xyz';

      const mockFetch = vi
        .fn()
        // 1st call: HEAD redirect
        .mockResolvedValueOnce({
          status: 302,
          headers: new Headers({ location: edgeUrl }),
        })
        // 2nd call: HEAD to edge server
        .mockResolvedValueOnce({
          status: 200,
          headers: new Headers({
            'content-length': '50000000000',
            'accept-ranges': 'bytes',
          }),
        });

      const handler = createProxyHandler(mockFetch as any);

      const req: any = {
        method: 'HEAD',
        query: { url: directUrl },
        headers: {},
      };

      const setHeaders: Record<string, string> = {};
      const res: any = new PassThrough();
      res.status = vi.fn().mockReturnThis();
      res.setHeader = vi.fn((k: string, v: string) => {
        setHeaders[k.toLowerCase()] = v;
      });
      res.end = vi.fn();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(setHeaders['content-type']).toBe('video/x-matroska');
      expect(setHeaders['content-length']).toBe('50000000000');
      expect(setHeaders['accept-ranges']).toBe('bytes');
      expect(res.end).toHaveBeenCalled();
    });

    it('should stream GET range requests with proper headers', async () => {
      const directUrl =
        'https://user:pass@members.easynews.com/dl/farm/port/movie.mkv';
      const edgeUrl =
        'https://ams-dl-01.easynews.com/dl/farm/port/movie.mkv?sig=xyz';

      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('video chunk'));
          controller.close();
        },
      });

      const mockFetch = vi
        .fn()
        // 1st call: HEAD redirect
        .mockResolvedValueOnce({
          status: 302,
          headers: new Headers({ location: edgeUrl }),
        })
        // 2nd call: GET to edge server
        .mockResolvedValueOnce({
          status: 206,
          headers: new Headers({
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
      res.send = vi.fn();

      await handler(req, res);

      expect(res.status).toHaveBeenCalledWith(206);
      expect(setHeaders['content-type']).toBe('video/x-matroska');
      expect(setHeaders['content-range']).toBe('bytes 0-10/1000');
      expect(setHeaders['accept-ranges']).toBe('bytes');
    });
  });
});
