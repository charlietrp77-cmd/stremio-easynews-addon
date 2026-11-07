# Easynews Addon Improvement & Architecture Plan

## Executive Summary
An analysis of the runtime performance (`.har` telemetry) for 4K Blu-Ray Remux streaming via Easynews reveals critical bottlenecks on constrained clients (like Android TV / ExoPlayer). These include single-threaded TCP throughput limitations over high-latency CDN routes (`ams-dl-01`), heavy TrueHD audio decoding overhead, and small client-side buffer caps. 

This document outlines an actionable engineering plan to upgrade the Stremio Easynews addon architecture—introducing client-side redirect optimization, audio codec filtering, and a local multi-connection range proxy.

---

## 1. Identified Performance Bottlenecks

1. **Single-Threaded HTTP Bottleneck:** Over a ~200ms round-trip latency link to European CDN nodes (`185.90.197.236` / `ams-dl-01`), a single TCP connection peaks around 32–45 Mbps. 4K Blu-Ray Remuxes frequently spike to 90–120 Mbps (averaging ~57 Mbps), causing Android TV ExoPlayer buffers to exhaust.
2. **CDN Geo-Routing Mismatch:** Public or cloud-hosted addon instances resolve Easynews `302` redirects using the *server's* IP rather than the *user's* local ISP routing table, potentially steering traffic to sub-optimal edge servers.
3. **Lossless Audio Overhead:** TrueHD Atmos 7.1 audio tracks force heavy software decoding on client streaming devices that lack hardware passthrough, choking the media pipeline alongside high-bitrate HEVC video.
4. **Strict ExoPlayer Buffer Limits:** Android TV media players maintain small default RAM buffers (~30 MB), translating to fewer than 4 seconds of headroom on high-bitrate 50 GB+ files.

---

## 2. Proposed Architectural Improvements

### Phase 1: Metadata & Codec Filtering (Addon Level)
* **Audio Track Filtering:** Update the addon's stream parser to inspect media metadata tags. Allow users to configure preferences to hide or deprioritize `TrueHD`, `Atmos`, and `DTS-HD.MA` in favor of compatible `EAC3 (DDP 5.1)` or `AAC` tracks on client devices.
* **Smart File Size Caps:** Implement a configurable profile setting in the addon options to automatically cap max file sizes (e.g., restricting results to 15–25 GB Web-DLs instead of 50 GB+ Remuxes for TV profiles).

### Phase 2: JIT Redirect Resolution (Self-Hosted Addon Level)
* **Local Proxy Handling:** When self-hosted locally (Docker / Node.js on a home server or PC), intercept playback requests.
* **Dynamic Location Header Extraction:** The local addon performs a manual `HEAD` request to `members.easynews.com/dl/...` using the user's local IP and credentials, extracts the exact pre-signed `?sig=` edge redirect URL (`ams-dl-01`), and streams it cleanly without cross-domain auth stripping or multi-hop latency penalties.

### Phase 3: Multi-Connection HTTP Range Proxy (High Performance)
To completely solve single-threaded throughput limits on 50 GB+ Remuxes, build a local multi-threading proxy layer into the self-hosted addon:
* **Concurrent Chunk Fetching:** Instead of a single TCP stream, open **4 to 8 parallel HTTP Range requests** simultaneously against the Easynews CDN nodes.
* **In-Memory Ring Buffer:** Assemble chunks sequentially inside a local server ring buffer (e.g., 64 MB RAM cache).
* **High-Speed Local Delivery:** Pipe a single, high-throughput local LAN stream (`http://192.168.x.x:port/stream`) into Android TV, multiplying effective throughput ($\approx 32\text{ Mbps} \times 4 = 128\text{ Mbps}$).

---

## 3. Implementation Status & Summary

All engineering phases have been implemented, tested, and pushed to the repository.

### Step 1: Environment & Project Setup (Completed)
* Configured local `pnpm` monorepo workspace and Node 24 multi-stage `Dockerfile`.
* Added `docker-compose.yml` for Portainer stack deployment.

### Step 2: Implement Codec Filtering Logic (Phase 1 - Completed)
* Built `filter.ts` with audio tag extraction (`TrueHD`, `Atmos`, `DTS-HD (MA / DTS:X)`, `DDP/E-AC3`, `AAC`).
* Configurable smart file size ceilings (`5 GB` – `50 GB`).
* Audio exclusions (`excludeTrueHD`, `excludeDTSHD`) and lossy stream prioritization (`deprioritizeLosslessAudio`).
* Visual audio codec badges displayed on Stremio stream selection cards (`🔊 TrueHD / Atmos`).
* Verified with unit tests in `filter.test.ts`.

### Step 3: Build Multi-Connection Proxy & JIT Redirect Resolver (Phases 2 & 3 - Completed)
* Built `proxy.ts` to perform manual `HEAD` requests using local IP/credentials, extracting pre-signed edge CDN redirect URLs (`ams-dl-01.easynews.com`) with a 1-hour TTL cache.
* Built `multi-downloader.ts` opening 4 to 8 parallel HTTP Range requests concurrently, feeding an in-memory sliding buffer (`~48 MB RAM`) with client backpressure handling.
* Verified with unit and integration tests in `proxy.test.ts` and `multi-downloader.test.ts` (42 tests total).

### Step 4: Portainer Deployment & Zero-Port-Forwarding Local SSL (Completed)
* **Environment Credentials**: `EASYNEWS_USERNAME` and `EASYNEWS_PASSWORD` configured in container environment variables to allow 1-click install without credentials in URLs.
* **Local LAN Zero-Port-Forwarding SSL (DuckDNS + Caddy DNS-01)**: Solves the browser "Failed to fetch" error on `web.stremio.com` by using DuckDNS with DNS-01 challenge. Points to your local LAN IP without opening any ports on your router.
* **Pure Local HTTP**: For Stremio Android TV and Desktop apps, direct local LAN IP `http://<SERVER_IP>:1337/manifest.json` works natively without domains or SSL.
