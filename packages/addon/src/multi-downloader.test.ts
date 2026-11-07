import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { MultiChunkDownloader } from './multi-downloader.js';

describe('MultiChunkDownloader (Phase 3)', () => {
  it('should fetch chunks concurrently and emit sequentially in order', async () => {
    const totalSize = 10 * 1024; // 10 KB
    const chunkSize = 2 * 1024; // 2 KB chunks -> 5 chunks total (0, 1, 2, 3, 4)

    // Track chunk fetch order
    const requestedRanges: string[] = [];

    const mockFetch = vi.fn().mockImplementation((url: string, opts: any) => {
      const range = opts.headers.Range;
      requestedRanges.push(range);

      // Return synthetic payload
      const payload = Buffer.alloc(chunkSize, range);
      return Promise.resolve({
        ok: true,
        status: 206,
        arrayBuffer: () => Promise.resolve(payload.buffer),
      });
    });

    const downloader = new MultiChunkDownloader({
      resolvedUrl: 'https://ams-dl-01.easynews.com/stream.mkv',
      forwardHeaders: {},
      startByte: 0,
      endByte: totalSize - 1,
      totalSize,
      chunkSize,
      concurrency: 3,
      fetchFn: mockFetch as any,
    });

    const mockRes: any = new PassThrough();
    const emittedBuffers: Buffer[] = [];

    mockRes.write = vi.fn((buf: Buffer) => {
      emittedBuffers.push(buf);
      return true;
    });
    mockRes.end = vi.fn();

    downloader.pipe(mockRes);

    // Wait for asynchronous downloads to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(requestedRanges).toEqual([
      'bytes=0-2047',
      'bytes=2048-4095',
      'bytes=4096-6143',
      'bytes=6144-8191',
      'bytes=8192-10239',
    ]);

    expect(emittedBuffers.length).toBe(5);
    expect(mockRes.end).toHaveBeenCalled();
  });

  it('should abort ongoing downloads if client disconnects', async () => {
    let aborted = false;

    const mockFetch = vi.fn().mockImplementation((url: string, opts: any) => {
      opts.signal?.addEventListener('abort', () => {
        aborted = true;
      });
      return new Promise(() => {}); // never resolves
    });

    const downloader = new MultiChunkDownloader({
      resolvedUrl: 'https://ams-dl-01.easynews.com/stream.mkv',
      forwardHeaders: {},
      startByte: 0,
      endByte: 10000,
      totalSize: 10000,
      chunkSize: 1000,
      concurrency: 2,
      fetchFn: mockFetch as any,
    });

    const mockRes: any = new PassThrough();
    mockRes.write = vi.fn().mockReturnValue(true);

    downloader.pipe(mockRes);

    // Simulate client closing connection
    mockRes.emit('close');

    expect(aborted).toBe(true);
  });
});

