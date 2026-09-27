# BiliBoost
[简体中文](./README.zh-CN.md)

A Tampermonkey userscript that keeps Bilibili playable on overseas connections.

## The problem

Measurements from outside mainland China (July 2026, 12-video sample):

- CDN node performance depends on whether the video is in that node's edge cache, which in turn depends on how popular the video is. Popular videos stream at 40-500 Mbps from the overseas nodes Bilibili assigns. Unpopular ones time out on both the primary and the backup node, and the player gives up.
- Some tools on GitHub try to improve playback by swapping CDN hosts, but this does not help with high-bitrate video.
- Cross-border routes throttle each TCP stream to about 1.4-2.3 Mbps. No node choice beats a per-stream cap; parallel range requests across several nodes do (3-15x in testing).
- Mainland mirror nodes serve hot and cold content reliably, and any `bilivideo.com` host works after a plain hostname swap. `akamaized.net` uses a separate signature scheme: URLs rewritten to it get 403, but URLs natively assigned to it play fine.
- Without the script, reliable playback topped out at standard-bitrate 1080p in testing. With the script installed, every video tested played smoothly, including 4K videos and cold content.

## What the script does

- Probes candidate nodes per video with two-point sampling (file head plus a deep offset) and routes to the winner. Head-only sampling misses nodes that only cached the first few megabytes.
- Splits large media requests into parts fetched from several nodes at once, with a per-part watchdog and cross-node hole filling. Measured 22-103 Mbps where a single stream got about 2 Mbps; one problem video went from a 37-second start to 251 ms.
- Falls back through a candidate chain on cache misses, warms the preferred node in the background, and force-switches nodes when playback stalls.
- Keeps the buffer alive in background tabs through a media-driven heartbeat, so returning to the tab does not mean rebuffering.
- Shows live throughput in a small capsule on the video page. Clicking it opens a panel with the current speed and buffer, how each load is split across nodes, per-node stats with a speed test, and diagnostics with a copyable report. The panel follows Bilibili's light or dark theme.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Import `bilibili-cdn-optimizer.user.js`.

Covers `/video/*`, `/bangumi/play/*`, `/list/*`, `/festival/*`, and `/watchlater/*`. Settings live in `localStorage` and are edited from the panel.

## Previewing the UI

Open `tools/ui-preview.html` in Chrome or Edge, or serve the repository root with any static server. The page loads the script against a simulated CDN, so it does not contact Bilibili. Add `?dark=1` for a dark page, or `?s=cold`, `?s=flaky`, or `?s=congested` to start in a failure scenario.

## Limits

- The script may stop working in the future.
- Verified working on August 12, 2026.
