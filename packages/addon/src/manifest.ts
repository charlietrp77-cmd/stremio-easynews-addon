import { Manifest, ManifestCatalog } from '@stremio-addon/sdk';
import {
  DirectionKey,
  humanReadableDirections,
  humanReadableSortOptions,
  toHumanReadable,
} from './sort-option.js';
import packageJson from '../package.json' with { type: 'json' };

const { version, description } = packageJson;

export const catalog: ManifestCatalog = {
  id: 'easynews-plus',
  name: 'Easynews+',
  type: 'tv',
  extra: [{ name: 'search', isRequired: true }],
};

// TODO: fix in '@types/stremio-addon-sdk'
const sortOptions = humanReadableSortOptions as any;
const directionOptions = humanReadableDirections as any;

export const hasEnvCredentials = !!(
  (process.env.EASYNEWS_USERNAME || process.env.USERNAME) &&
  (process.env.EASYNEWS_PASSWORD || process.env.PASSWORD)
);

export const manifest: Manifest & {
  stremioAddonsConfig: { issuer: string; signature: string };
} = {
  id: 'community.easynews-plus',
  version,
  description,
  catalogs: [catalog],
  resources: [
    'catalog',
    { name: 'meta', types: ['tv'], idPrefixes: [catalog.id] },
    { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt'] },
  ],
  types: ['movie', 'series', 'tv'],
  name: 'Easynews+',
  background:
    'https://images.pexels.com/photos/518543/pexels-photo-518543.jpeg',
  logo: 'https://pbs.twimg.com/profile_images/479627852757733376/8v9zH7Yo_400x400.jpeg',
  behaviorHints: {
    configurable: true,
    configurationRequired: !hasEnvCredentials,
  },
  config: [
    {
      title: 'username',
      key: 'username',
      type: 'text',
      default: process.env.EASYNEWS_USERNAME || process.env.USERNAME || '',
      required: !hasEnvCredentials,
    },
    {
      title: 'password',
      key: 'password',
      type: 'password',
      default: process.env.EASYNEWS_PASSWORD || process.env.PASSWORD || '',
      required: !hasEnvCredentials,
    },
    {
      title: 'Enable Local Streaming Proxy (JIT Redirect)',
      key: 'enableProxy',
      type: 'checkbox',
      default: 'checked',
    },
    {
      title: 'Custom Proxy Host (e.g. http://192.168.1.50:1337 - optional)',
      key: 'proxyHost',
      type: 'text',
    },
    {
      title: 'Max File Size Cap',
      key: 'maxFileSizeGb',
      type: 'select',
      options: [
        'No limit',
        '5 GB',
        '10 GB',
        '15 GB',
        '20 GB',
        '25 GB',
        '30 GB',
        '40 GB',
        '50 GB',
      ],
      default: 'No limit',
    },
    {
      title: 'Exclude TrueHD Audio (TV compatibility)',
      key: 'excludeTrueHD',
      type: 'checkbox',
    },
    {
      title: 'Exclude DTS-HD / DTS-X Audio',
      key: 'excludeDTSHD',
      type: 'checkbox',
    },
    {
      title: 'Deprioritize Lossless Audio (favor EAC3 / AAC)',
      key: 'deprioritizeLosslessAudio',
      type: 'checkbox',
      default: 'checked',
    },
    {
      title: 'Sort 1st',
      key: 'sort1',
      type: 'select',
      options: sortOptions,
      default: toHumanReadable('Size'),
    },
    {
      title: 'Sort 1st direction',
      key: 'sort1Direction',
      type: 'select',
      options: directionOptions,
      default: 'Descending' satisfies DirectionKey,
    },
    {
      title: 'Sort 2nd',
      key: 'sort2',
      type: 'select',
      options: sortOptions,
      default: toHumanReadable('Relevance'),
    },
    {
      title: 'Sort 2nd direction',
      key: 'sort2Direction',
      type: 'select',
      options: directionOptions,
      default: 'Descending' satisfies DirectionKey,
    },
    {
      title: 'Sort 3rd',
      key: 'sort3',
      type: 'select',
      options: sortOptions,
      default: toHumanReadable('DateTime'),
    },
    {
      title: 'Sort 3rd direction',
      key: 'sort3Direction',
      type: 'select',
      options: directionOptions,
      default: 'Descending' satisfies DirectionKey,
    },
  ],
  stremioAddonsConfig: {
    issuer: 'https://stremio-addons.net',
    signature:
      'eyJhbGciOiJkaXIiLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..sTSjsQkUq2uSSxmLIPlfVw.OvjIByO6oPi73f5KG6qKJRxiiRNv4-YVeW3ywzquK8wTh0mSKJnrdaFFiSzW7lHliaH_adh_VN-PNtH4VBSRbWfN-xbDfNw5KcRx9oRFAEAt0adV-dF1oF03dG9Oupqj.aK03nhKF4q4uc-s1ADiZfg',
  },
};
