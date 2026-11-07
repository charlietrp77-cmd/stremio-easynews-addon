import express from 'express';
import { getRouter } from '@stremio-addon/compat';
import { landingTemplate } from '@stremio-addon/compat/landing-template';
import { addonInterface } from './addon.js';
import { proxyStreamHandler, getLocalIp, getProxyBaseUrl } from './proxy.js';

export function createServer(): express.Application {
  const app: express.Application = express();

  // CORS headers
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    next();
  });

  // Local Streaming Proxy endpoint (Phase 2: JIT Redirect Resolution)
  app.all('/proxy/stream', proxyStreamHandler);

  // Stremio Addon Router
  app.use(getRouter(addonInterface));

  // Landing & Configure pages
  const landingHTML = landingTemplate(addonInterface.manifest);
  app.get('/', (_req, res) => {
    if (addonInterface.manifest.behaviorHints?.configurationRequired) {
      res.redirect('/configure');
    } else {
      res.setHeader('content-type', 'text/html');
      res.end(landingHTML);
    }
  });

  app.get('/configure', (_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(landingHTML);
  });

  return app;
}

export function startServer(
  port: number = +(process.env.PORT ?? 1337),
  host: string = process.env.HOST ?? '0.0.0.0'
) {
  const app = createServer();
  const server = app.listen(port, host, () => {
    const localUrl = `http://127.0.0.1:${port}/manifest.json`;
    const lanUrl = `http://${getLocalIp()}:${port}/manifest.json`;
    console.log('----------------------------------------------------');
    console.log('Easynews+ Addon & Streaming Proxy Started');
    console.log('Local Addon URL:   ', localUrl);
    console.log('LAN Addon URL:     ', lanUrl);
    console.log('Proxy Stream URL:  ', `${getProxyBaseUrl()}/proxy/stream`);
    console.log('----------------------------------------------------');
  });
  return server;
}

// Auto-start if executed directly
if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  startServer();
}
