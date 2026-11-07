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

## 3. Implementation Plan for Antigravity

Follow these phases inside Antigravity to build, test, and deploy the upgraded local addon proxy.

### Step 1: Environment & Project Setup
* Clone or initialize your local fork of the Easynews Stremio addon codebase in Antigravity.
* Set up a local Node.js / Docker development container.

### Step 2: Implement Codec Filtering Logic
* Modify `addon.js` / stream parser logic to inspect stream titles and metadata:
  ```javascript
  // Example filter logic pseudo-code
  function filterStreams(streams, userConfig) {
      return streams.filter(stream => {
          if (userConfig.excludeTrueHD && stream.title.includes("TrueHD")) {
              return false;
          }
          return true;
      });
  }
  ```

### Step 3: Build the Multi-Connection Proxy Module
* Create a new module (`proxy.js`) utilizing Node.js `http` and `stream` pipelines to handle multi-range chunk requests:
  * Parse incoming `Range` headers from ExoPlayer.
  * Spawn concurrent `axios` or `node-fetch` range requests.
  * Buffer and pipe segments sequentially to the client response stream.

### Step 4: Verification & Benchmarking
* Run the local addon container.
* Point Stremio on Android TV to the local addon instance.
* Monitor network throughput metrics and buffer stability using Kodi external player stats (`O` key) or router bandwidth monitors during a high-bitrate 4K Remux playback test.