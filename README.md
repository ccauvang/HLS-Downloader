# HLS Downloader

MV3 Chrome extension. Detects HLS (`.m3u8`) streams on a page, downloads segments, decrypts if AES-128, remuxes to MP4/TS via ffmpeg.wasm.

## Features

- Auto-detect m3u8 via `webRequest` (URL + content-type), fetch/XHR body sniff, DOM `<video>`/`<source>` scan
- Master playlist support - auto-picks highest-bandwidth variant
- fMP4 (CMAF) and plain TS segment support, separate audio rendition muxing
- AES-128 decrypt (key captured passively via page's own XHR/fetch, not re-fetched)
- Concurrency-limited worker-pool download, configurable chunk delay (rate-limit dodge), auto-retry + backoff on 429
- Save as MP4 (ffmpeg remux) or TS (raw concat, ffmpeg skipped)
- Download history (local), per-site detection pause/blacklist

## Install (unpacked)

1. `chrome://extensions`
2. Enable Developer mode
3. Load unpacked -> select repo root (folder with `manifest.json`)

## Usage

1. Open a page with an HLS stream, click extension icon
2. Pick detected stream from dropdown, or paste m3u8 URL + hit parse (⬇)
3. Set filename + format (MP4/TS)
4. Start download - pick save location - progress bar shows speed/ETA
5. History tab (☰) keeps past downloads; Settings tab (⚙)

## Permissions

`downloads`, `scripting`, `activeTab`, `storage`, `tabs`, `webRequest`, `alarms`, host access `*://*/*`

## Notes

- Popup runs as a separate window (not default browserAction popup) so it survives tab switches during a download
- Service worker kept alive via a periodic no-op alarm (MV3 SW idle-kill workaround)
- MPD/DASH: not supported yet
