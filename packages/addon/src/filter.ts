import { FileData } from '@easynews/api';
import { parse as parseTorrentTitle } from 'parse-torrent-title';

export interface MediaInfo {
  title: string;
  rawSize?: number;
  resolution?: string;
  source?: string;
  codec?: string;
  audioTags: string[];
  isTrueHD: boolean;
  isAtmos: boolean;
  isDTSHD: boolean;
  isLosslessAudio: boolean;
  isCompatibleAudio: boolean;
}

export interface FilterConfig {
  maxFileSizeGb?: string | number;
  excludeTrueHD?: string | boolean;
  excludeDTSHD?: string | boolean;
  deprioritizeLosslessAudio?: string | boolean;
}

/**
 * Inspects title and file data to parse video and audio codec metadata.
 */
export function parseMediaInfo(title: string, file?: FileData): MediaInfo {
  const ptt = parseTorrentTitle(title);
  const lowerTitle = title.toLowerCase();

  const audioTags: string[] = [];

  const isTrueHD =
    lowerTitle.includes('truehd') ||
    lowerTitle.includes('true-hd') ||
    ptt.audio?.toLowerCase() === 'truehd';

  const isAtmos =
    lowerTitle.includes('atmos') || ptt.audio?.toLowerCase() === 'atmos';

  const isDTSHD =
    lowerTitle.includes('dts-hd') ||
    lowerTitle.includes('dtshd') ||
    lowerTitle.includes('dts-x') ||
    lowerTitle.includes('dtsx') ||
    ptt.audio?.toLowerCase() === 'dts-hd' ||
    ptt.audio?.toLowerCase() === 'dts-hd ma';

  const isLosslessAudio = isTrueHD || isDTSHD;

  const isEAC3 =
    lowerTitle.includes('ddp') ||
    lowerTitle.includes('dd+') ||
    lowerTitle.includes('eac3') ||
    lowerTitle.includes('e-ac-3') ||
    ptt.audio?.toLowerCase() === 'eac3';

  const isAAC =
    lowerTitle.includes('aac') ||
    file?.['18']?.toUpperCase() === 'AAC' ||
    ptt.audio?.toLowerCase() === 'aac';

  const isAC3 =
    lowerTitle.includes('ac3') ||
    lowerTitle.includes('dd5.1') ||
    ptt.audio?.toLowerCase() === 'ac3';

  if (isTrueHD) audioTags.push('TrueHD');
  if (isAtmos) audioTags.push('Atmos');
  if (isDTSHD) audioTags.push('DTS-HD');
  if (isEAC3) audioTags.push('DDP/E-AC3');
  if (isAC3 && !isEAC3) audioTags.push('AC3');
  if (isAAC) audioTags.push('AAC');

  const isCompatibleAudio = isEAC3 || isAAC || isAC3;

  return {
    title,
    rawSize: file?.rawSize,
    resolution: ptt.resolution || file?.fullres,
    source: ptt.source,
    codec: ptt.codec,
    audioTags,
    isTrueHD,
    isAtmos,
    isDTSHD,
    isLosslessAudio,
    isCompatibleAudio,
  };
}

/**
 * Checks if a file should be excluded based on user audio codec & file size preferences.
 */
export function shouldExcludeFile(file: FileData, config: FilterConfig): boolean {
  const title = file['10'] ?? '';
  const media = parseMediaInfo(title, file);

  // 1. Max File Size Cap
  if (config.maxFileSizeGb && config.maxFileSizeGb !== 'No limit') {
    const maxGb =
      typeof config.maxFileSizeGb === 'number'
        ? config.maxFileSizeGb
        : parseFloat(config.maxFileSizeGb.toString().replace(/[^\d.]/g, ''));

    if (!isNaN(maxGb) && maxGb > 0 && file.rawSize) {
      const maxBytes = maxGb * 1024 * 1024 * 1024;
      if (file.rawSize > maxBytes) {
        return true;
      }
    }
  }

  // 2. Exclude TrueHD
  const excludeTrueHD =
    config.excludeTrueHD === true || config.excludeTrueHD === 'true' || config.excludeTrueHD === 'checked';
  if (excludeTrueHD && media.isTrueHD) {
    return true;
  }

  // 3. Exclude DTS-HD / DTS-X
  const excludeDTSHD =
    config.excludeDTSHD === true || config.excludeDTSHD === 'true' || config.excludeDTSHD === 'checked';
  if (excludeDTSHD && media.isDTSHD) {
    return true;
  }

  return false;
}

/**
 * Sorts/deprioritizes lossless audio streams (TrueHD, DTS-HD MA)
 * after compatible tracks (E-AC3 / DDP / AAC) if configured.
 */
export function prioritizeStreams<T extends { title: string; file?: FileData }>(
  items: T[],
  config: FilterConfig
): T[] {
  const deprioritize =
    config.deprioritizeLosslessAudio === true ||
    config.deprioritizeLosslessAudio === 'true' ||
    config.deprioritizeLosslessAudio === 'checked';

  if (!deprioritize) {
    return items;
  }

  return [...items].sort((a, b) => {
    const mediaA = parseMediaInfo(a.title, a.file);
    const mediaB = parseMediaInfo(b.title, b.file);

    // If A is lossless and B is compatible, B comes first
    if (mediaA.isLosslessAudio && !mediaB.isLosslessAudio && mediaB.isCompatibleAudio) {
      return 1;
    }
    // If B is lossless and A is compatible, A comes first
    if (!mediaA.isLosslessAudio && mediaA.isCompatibleAudio && mediaB.isLosslessAudio) {
      return -1;
    }

    return 0; // maintain original search/rank order
  });
}

