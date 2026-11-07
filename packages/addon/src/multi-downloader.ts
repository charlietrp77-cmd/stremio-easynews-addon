import { Response } from 'express';

export interface MultiDownloaderOptions {
  resolvedUrl: string;
  forwardHeaders: Record<string, string>;
  startByte: number;
  endByte: number; // inclusive
  totalSize: number;
  chunkSize?: number; // default 4 MB
  concurrency?: number; // default 4 parallel requests
  maxBufferChunks?: number; // default 12 chunks (48 MB)
  fetchFn?: typeof fetch;
}

export class MultiChunkDownloader {
  private resolvedUrl: string;
  private forwardHeaders: Record<string, string>;
  private startByte: number;
  private endByte: number;
  private totalSize: number;
  private chunkSize: number;
  private concurrency: number;
  private maxBufferChunks: number;
  private fetchFn: typeof fetch;

  private totalChunks: number;
  private startChunkIndex: number;
  private nextChunkToDownload: number;
  private nextChunkToEmit: number;

  private activeControllers = new Map<number, AbortController>();
  private bufferedChunks = new Map<number, Buffer>();
  private isDestroyed = false;
  private isDraining = false;
  private clientRes?: Response;

  constructor(opts: MultiDownloaderOptions) {
    this.resolvedUrl = opts.resolvedUrl;
    this.forwardHeaders = opts.forwardHeaders;
    this.startByte = opts.startByte;
    this.endByte = opts.endByte;
    this.totalSize = opts.totalSize;
    this.chunkSize = opts.chunkSize ?? 4 * 1024 * 1024; // 4 MB
    this.concurrency = opts.concurrency ?? 4;
    this.maxBufferChunks = opts.maxBufferChunks ?? 12; // ~48 MB RAM
    this.fetchFn = opts.fetchFn ?? fetch;

    this.startChunkIndex = Math.floor(this.startByte / this.chunkSize);
    const lastChunkIndex = Math.floor(this.endByte / this.chunkSize);
    this.totalChunks = lastChunkIndex + 1;

    this.nextChunkToDownload = this.startChunkIndex;
    this.nextChunkToEmit = this.startChunkIndex;
  }

  /**
   * Pipe multi-connection downloaded stream to Express client response.
   */
  public pipe(res: Response): void {
    this.clientRes = res;

    res.on('close', () => {
      this.destroy();
    });

    res.on('drain', () => {
      this.drainToClient();
    });

    this.scheduleDownloads();
  }

  public destroy(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.bufferedChunks.clear();
  }

  private scheduleDownloads(): void {
    if (this.isDestroyed) return;

    while (
      this.activeControllers.size < this.concurrency &&
      this.nextChunkToDownload < this.totalChunks &&
      this.nextChunkToDownload - this.nextChunkToEmit < this.maxBufferChunks
    ) {
      const chunkIdx = this.nextChunkToDownload++;
      this.fetchChunk(chunkIdx);
    }
  }

  private async fetchChunk(chunkIdx: number, retryCount = 0): Promise<void> {
    if (this.isDestroyed) return;

    // Calculate exact byte bounds for this chunk
    const chunkStartAbsolute = chunkIdx * this.chunkSize;
    const chunkEndAbsolute = Math.min((chunkIdx + 1) * this.chunkSize - 1, this.endByte);

    // If this is the start chunk, offset from startByte
    const fetchStart = Math.max(chunkStartAbsolute, this.startByte);
    const fetchEnd = chunkEndAbsolute;

    if (fetchStart > fetchEnd) {
      return;
    }

    const controller = new AbortController();
    this.activeControllers.set(chunkIdx, controller);

    try {
      const headers = {
        ...this.forwardHeaders,
        Range: `bytes=${fetchStart}-${fetchEnd}`,
      };

      const res = await this.fetchFn(this.resolvedUrl, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      if (!res.ok && res.status !== 206) {
        throw new Error(`Upstream chunk HTTP ${res.status}`);
      }

      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);

      if (this.isDestroyed) return;

      this.activeControllers.delete(chunkIdx);
      this.bufferedChunks.set(chunkIdx, buffer);

      // Attempt to flush buffered chunks to client
      this.drainToClient();

      // Trigger more downloads to keep the pipeline filled
      this.scheduleDownloads();
    } catch (err: any) {
      this.activeControllers.delete(chunkIdx);

      if (this.isDestroyed || err.name === 'AbortError') {
        return;
      }

      if (retryCount < 3) {
        // Retry failed chunk
        this.fetchChunk(chunkIdx, retryCount + 1);
      } else {
        console.error(`MultiChunkDownloader failed chunk ${chunkIdx} after 3 retries:`, err);
        if (this.clientRes && !this.clientRes.writableEnded) {
          this.clientRes.destroy(err);
        }
        this.destroy();
      }
    }
  }

  private drainToClient(): void {
    if (this.isDestroyed || this.isDraining || !this.clientRes) {
      return;
    }

    this.isDraining = true;

    try {
      while (this.bufferedChunks.has(this.nextChunkToEmit)) {
        const buffer = this.bufferedChunks.get(this.nextChunkToEmit)!;
        this.bufferedChunks.delete(this.nextChunkToEmit);
        this.nextChunkToEmit++;

        const canContinue = this.clientRes.write(buffer);

        // Schedule downloads since buffer space was freed
        this.scheduleDownloads();

        if (!canContinue) {
          // Client backpressure, wait for 'drain' event
          this.isDraining = false;
          return;
        }
      }

      // Check if we have emitted everything up to the requested end
      if (this.nextChunkToEmit >= this.totalChunks) {
        this.clientRes.end();
        this.destroy();
      }
    } finally {
      this.isDraining = false;
    }
  }
}

