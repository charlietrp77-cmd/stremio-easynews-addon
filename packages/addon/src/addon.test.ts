import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { addonInterface } from './addon.js';

describe('Addon Environment Credentials', () => {
  const origUser = process.env.EASYNEWS_USERNAME;
  const origPass = process.env.EASYNEWS_PASSWORD;

  beforeEach(() => {
    delete process.env.EASYNEWS_USERNAME;
    delete process.env.EASYNEWS_PASSWORD;
  });

  afterEach(() => {
    if (origUser) process.env.EASYNEWS_USERNAME = origUser;
    else delete process.env.EASYNEWS_USERNAME;
    if (origPass) process.env.EASYNEWS_PASSWORD = origPass;
    else delete process.env.EASYNEWS_PASSWORD;
  });

  it('should return empty streams gracefully when no credentials are provided in URL or env', async () => {
    const res = await addonInterface.get('stream', 'movie', 'tt1234567', {}, {});
    expect(res).toEqual({ streams: [] });
  });

  it('should accept credentials passed in config object', async () => {
    // Should proceed to fetch from API (or return empty streams if query fails, without crashing)
    const res = await addonInterface.get(
      'stream',
      'movie',
      'invalid_id', // non-tt id
      {},
      { username: 'testuser', password: 'testpassword' }
    );
    expect(res).toEqual({ streams: [] });
  });
});

