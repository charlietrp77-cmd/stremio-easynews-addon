import { describe, it, expect } from 'vitest';
import {
  parseMediaInfo,
  shouldExcludeFile,
  prioritizeStreams,
} from './filter.js';
import { FileData } from '@easynews/api';

describe('Filter Module (Phase 1: Metadata & Codec Filtering)', () => {
  describe('parseMediaInfo', () => {
    it('should detect TrueHD and Atmos audio tags', () => {
      const media = parseMediaInfo(
        'Dune.Part.Two.2024.2160p.UHD.BluRay.Remux.DV.HDR.TrueHD.Atmos.7.1.H.265-FLUX'
      );
      expect(media.isTrueHD).toBe(true);
      expect(media.isAtmos).toBe(true);
      expect(media.isLosslessAudio).toBe(true);
      expect(media.audioTags).toContain('TrueHD');
      expect(media.audioTags).toContain('Atmos');
    });

    it('should detect DTS-HD and DTS-X audio tags', () => {
      const media = parseMediaInfo(
        'Oppenheimer.2023.1080p.BluRay.x264.DTS-HD.MA.5.1-GRP'
      );
      expect(media.isDTSHD).toBe(true);
      expect(media.isLosslessAudio).toBe(true);
      expect(media.audioTags).toContain('DTS-HD');
    });

    it('should detect compatible DDP / E-AC3 and AAC audio tags', () => {
      const media1 = parseMediaInfo(
        'Severance.S01E01.2160p.WEB-DL.DDP5.1.Atmos.H.265'
      );
      expect(media1.isCompatibleAudio).toBe(true);
      expect(media1.isLosslessAudio).toBe(false);
      expect(media1.audioTags).toContain('DDP/E-AC3');
      expect(media1.audioTags).toContain('Atmos');

      const media2 = parseMediaInfo(
        'Show.S02E03.1080p.WEB.H264-AAC'
      );
      expect(media2.isCompatibleAudio).toBe(true);
      expect(media2.audioTags).toContain('AAC');
    });
  });

  describe('shouldExcludeFile (Smart Caps & Audio Filtering)', () => {
    const makeFile = (title: string, rawSize: number): FileData =>
      ({
        '0': 'hash123',
        '10': title,
        rawSize,
      } as any);

    it('should filter out files exceeding maxFileSizeGb', () => {
      // 55 GB file
      const remux55Gb = makeFile(
        'Movie.2160p.Remux.TrueHD.mkv',
        55 * 1024 * 1024 * 1024
      );
      // 18 GB file
      const webdl18Gb = makeFile(
        'Movie.2160p.WEB-DL.DDP5.1.mkv',
        18 * 1024 * 1024 * 1024
      );

      // Capped at 25 GB
      expect(shouldExcludeFile(remux55Gb, { maxFileSizeGb: '25 GB' })).toBe(true);
      expect(shouldExcludeFile(webdl18Gb, { maxFileSizeGb: '25 GB' })).toBe(false);

      // No limit
      expect(shouldExcludeFile(remux55Gb, { maxFileSizeGb: 'No limit' })).toBe(false);
    });

    it('should filter out TrueHD when excludeTrueHD is enabled', () => {
      const truehdFile = makeFile('Movie.TrueHD.Atmos.7.1.mkv', 20 * 1024 * 1024 * 1024);
      const eac3File = makeFile('Movie.DDP5.1.Atmos.mkv', 20 * 1024 * 1024 * 1024);

      expect(shouldExcludeFile(truehdFile, { excludeTrueHD: true })).toBe(true);
      expect(shouldExcludeFile(eac3File, { excludeTrueHD: true })).toBe(false);
    });

    it('should filter out DTS-HD when excludeDTSHD is enabled', () => {
      const dtshdFile = makeFile('Movie.DTS-HD.MA.7.1.mkv', 20 * 1024 * 1024 * 1024);
      const aacFile = makeFile('Movie.AAC.mkv', 10 * 1024 * 1024 * 1024);

      expect(shouldExcludeFile(dtshdFile, { excludeDTSHD: true })).toBe(true);
      expect(shouldExcludeFile(aacFile, { excludeDTSHD: true })).toBe(false);
    });
  });

  describe('prioritizeStreams (Deprioritize Lossless Audio)', () => {
    it('should sort compatible tracks ahead of lossless tracks when enabled', () => {
      const streams = [
        { title: 'Movie.2160p.Remux.TrueHD.Atmos.7.1.mkv' },
        { title: 'Movie.2160p.WEB-DL.DDP5.1.Atmos.mkv' },
      ];

      const prioritized = prioritizeStreams(streams, {
        deprioritizeLosslessAudio: true,
      });

      expect(prioritized[0].title).toBe('Movie.2160p.WEB-DL.DDP5.1.Atmos.mkv');
      expect(prioritized[1].title).toBe('Movie.2160p.Remux.TrueHD.Atmos.7.1.mkv');
    });

    it('should preserve original order when deprioritizeLosslessAudio is disabled', () => {
      const streams = [
        { title: 'Movie.2160p.Remux.TrueHD.Atmos.7.1.mkv' },
        { title: 'Movie.2160p.WEB-DL.DDP5.1.Atmos.mkv' },
      ];

      const unchanged = prioritizeStreams(streams, {
        deprioritizeLosslessAudio: false,
      });

      expect(unchanged[0].title).toBe('Movie.2160p.Remux.TrueHD.Atmos.7.1.mkv');
      expect(unchanged[1].title).toBe('Movie.2160p.WEB-DL.DDP5.1.Atmos.mkv');
    });
  });
});

