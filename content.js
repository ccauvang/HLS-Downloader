(function () {
    'use strict';

    // Hook fetch/XHR immediately at document_start
    const detectedM3u8 = [];

    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('.m3u8') && !detectedM3u8.includes(url)) {
            detectedM3u8.push(url);
            if (typeof updateDropdown === 'function') updateDropdown();
        }
        return _origFetch(...args);
    };

    const _origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (typeof url === 'string' && url.includes('.m3u8') && !detectedM3u8.includes(url)) {
            detectedM3u8.push(url);
            if (typeof updateDropdown === 'function') updateDropdown();
        }
        return _origOpen.call(this, method, url, ...rest);
    };

    // Mount UI after DOM ready
    document.addEventListener('DOMContentLoaded', async () => {
        if (document.getElementById('hls-dl-host')) return;

        // ── Intercept fetch/XHR to catch m3u8 URLs ───────────────────────────────
        const detectedM3u8 = [];

        const _origFetch = window.fetch.bind(window);
        window.fetch = async function (...args) {
            const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
            if (url.includes('.m3u8') && !detectedM3u8.includes(url)) {
                detectedM3u8.push(url);
                updateDropdown();
            }
            return _origFetch(...args);
        };

        const _origOpen = XMLHttpRequest.prototype.open;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            if (typeof url === 'string' && url.includes('.m3u8') && !detectedM3u8.includes(url)) {
                detectedM3u8.push(url);
                updateDropdown();
            }
            return _origOpen.call(this, method, url, ...rest);
        };

        // ── Load mux.js from extension ────────────────────────────────────────────
        await new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = chrome.runtime.getURL('lib/mux.js');
            s.onload = resolve;
            s.onerror = reject;
            document.documentElement.appendChild(s);
        });

        // ── Mount Shadow DOM ──────────────────────────────────────────────────────
        const host = document.createElement('div');
        host.id = 'hls-dl-host';
        Object.assign(host.style, {
            position: 'fixed', bottom: '24px', right: '24px',
            zIndex: '2147483647', width: '460px',
            pointerEvents: 'none', contain: 'layout style',
            willChange: 'transform', transition: 'none',
        });
        document.documentElement.appendChild(host);
        const shadow = host.attachShadow({ mode: 'open' });

        // ── Styles ────────────────────────────────────────────────────────────────
        const style = document.createElement('style');
        style.textContent = `
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=JetBrains+Mono&display=swap');
    * { box-sizing: border-box; }
    #panel {
      pointer-events: all; width: 460px; background: #1A1D1E;
      border: 1px solid #2a2a2a; border-radius: 12px;
      font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
      color: #e0e0e0; overflow: hidden;
    }
    #header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 14px; background: #3d0000; cursor: move;
      border-bottom: 1px solid #222;
    }
    #header-title { font-size: 18px; font-weight: bold; color: #e93434; letter-spacing: 1px; }
    #toggle-btn {
      background: none; border: none; color: #666; font-size: 25px;
      cursor: pointer; line-height: 1; padding: 0 2px;
    }
    #toggle-btn:hover { color: #f2f0ed; }
    #body { padding: 12px; display: flex; flex-direction: column; gap: 9px; }
    select {
      width: 100%; background: #141414; border: 1px solid #424141;
      border-radius: 7px; color: #ccc; font-size: 11.5px; padding: 7px 10px;
      outline: none; font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
      cursor: pointer;
    }
    select:focus { border-color: #e93434; }
    select option { background: #141414; }
    textarea {
      width: 100%; height: 110px; background: #141414; border: 1px solid #252525;
      border-radius: 7px; color: #ccc; font-size: 10.5px; padding: 7px;
      resize: vertical; outline: none;
      font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    }
    textarea:focus { border-color: #e93434; }
    input[type=text] {
      width: 100%; background: #141414; border: 1px solid #424141;
      border-radius: 7px; color: #ccc; font-size: 11.5px; padding: 7px 10px;
      outline: none; font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    }
    input[type=text]:focus { border-color: #e93434; }
    #fmt-mp4 {
      flex:1; padding:5px; border-radius:6px;
      border: 1px solid #3191f8; background:#3191f8;
      color:#f2f0ed; font-weight:bold; cursor:pointer;
    }
    #fmt-ts {
      flex:1; padding:5px; border-radius:6px;
      border: 1px solid #3191f8; background:#191c1e;
      color:#f2f0ed; font-weight:bold; cursor:pointer;
    }
    #parse-btn {
      background: #003e1c; color: #3DAD66; cursor: pointer;
      border: 1px solid #3DAD66; border-radius: 5px;
      padding: 4px; width: 40px; font-weight: 600;
    }
    #parse-btn:hover { background: #3DAD66; color: #f2f0ed; }
    #start-btn {
      flex:1; padding: 9px; background: #003e1c; color: #3DAD66;
      border: 1px solid #3DAD66; border-radius: 7px;
      font-weight: 800; font-size: 15px; cursor: pointer;
      letter-spacing: 3px; transition: background .15s;
      font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
    }
    #start-btn:hover { background: #3DAD66; color: #f2f0ed; }
    #start-btn:disabled { background: #252525; color: #4B4B4B; border: 1px solid #434343; cursor: not-allowed; }
    #cancel-btn {
      padding:9px 12px; background:#3d0000; color:#e93434;
      border:1px solid #e93434; border-radius:7px;
      font-weight:800; font-size:13px; cursor:pointer;
    }
    #cancel-btn:disabled { background: #252525; color: #4B4B4B; border: 1px solid #434343; cursor: not-allowed; }
    #bar-wrap-container { display: flex; align-items: center; gap: 6px; }
    #bar-wrap { flex: 1; background: #181818; border-radius: 5px; height: 5px; overflow: hidden; border: 1px solid #003e1c; }
    #bar-percent { font-size: 13px; color: #f2f0ed; min-width: 36px; text-align: right; }
    #bar { height: 100%; width: 0%; background: #3DAD66; transition: width .25s ease; border-radius: 5px; }
    #log {
      background: #090909; border: 1px solid #1c1c1c; border-radius: 7px;
      padding: 7px 8px; height: 150px; overflow-y: auto; font-size: 13px;
      color: #888; line-height: 1.7; white-space: pre-wrap; word-break: break-all;
      font-family: 'JetBrains Mono', 'Fira Code', 'Consolas', monospace;
    }
    #log::-webkit-scrollbar { width: 5px; }
    #log::-webkit-scrollbar-thumb { background: #2a2a2a; border-radius: 2px; }
    .ok  { color: #4caf50; }
    .err { color: #f44336; }
    .inf { color: #00e5ff; }
    .fire { color: #FF8800; }
    #copy-log-btn, #clear-log-btn {
      flex:1; padding: 5px; background: #191c1e;
      border: 1px solid #2a2a2a; border-radius: 6px;
      color: #888; font-size: 11px; cursor: pointer;
      font-family: 'Inter', sans-serif; font-weight: 700;
    }
    #copy-log-btn:hover { border-color: #3DAD66; color: #3DAD66; }
    #clear-log-btn:hover { border-color: #f44336; color: #f44336; }
    #detected-label { font-size: 11px; color: #555; }
  `;
        shadow.appendChild(style);

        // ── HTML ──────────────────────────────────────────────────────────────────
        const panel = document.createElement('div');
        panel.id = 'panel';
        panel.innerHTML = `
    <div id="header">
      <span id="header-title">HLS DOWNLOADER</span>
      <button id="toggle-btn">−</button>
    </div>
    <div id="body">
      <div>
        <div id="detected-label">Detected streams (0)</div>
        <div style="display:flex;gap:6px;margin-top:4px">
          <select id="m3u8-select" style="flex:1">
            <option value="">— no streams detected yet —</option>
          </select>
          <input type="text" id="m3u8-url" placeholder="or paste m3u8 URL…" style="flex:1" />
          <button id="parse-btn">⬇</button>
        </div>
      </div>
      <textarea id="links" placeholder="Paste segment URLs here, one per line..."></textarea>
      <input type="text" id="filename" value="video.mp4" placeholder="Output filename" />
      <div style="display:flex;gap:6px">
        <button id="fmt-mp4">MP4</button>
        <button id="fmt-ts">TS</button>
      </div>
      <div id="bar-wrap-container">
        <div id="bar-wrap"><div id="bar"></div></div>
        <span id="bar-percent">0%</span>
      </div>
      <div style="display:flex;gap:6px">
        <button id="start-btn">▶ START DOWNLOAD</button>
        <button id="cancel-btn">✕</button>
      </div>
      <div id="log"><span class="inf" style="display:block">Ready. Paste links and hit start.</span></div>
      <div style="display:flex;gap:6px">
        <button id="clear-log-btn">✕ Clear</button>
        <button id="copy-log-btn">⎘ Copy Log</button>
      </div>
    </div>
  `;
        shadow.appendChild(panel);

        // ── Dropdown update ───────────────────────────────────────────────────────
        const m3u8Select = shadow.getElementById('m3u8-select');
        const detectedLabel = shadow.getElementById('detected-label');
        function updateDropdown() {
            detectedLabel.textContent = `Detected streams (${detectedM3u8.length})`;
            m3u8Select.innerHTML = '<option value="">— select detected stream —</option>' +
                detectedM3u8.map((u, i) => `<option value="${u}">${i + 1}. ${u.split('/').pop().split('?')[0]}</option>`).join('');
        }
        m3u8Select.addEventListener('change', () => {
            if (m3u8Select.value) shadow.getElementById('m3u8-url').value = m3u8Select.value;
        });

        // ── Drag ──────────────────────────────────────────────────────────────────
        const header = shadow.getElementById('header');
        let dragging = false, ox = 0, oy = 0, anchorX = 0, anchorY = 0;
        header.addEventListener('mousedown', e => {
            if (e.target.id === 'toggle-btn') return;
            dragging = true;
            const rect = host.getBoundingClientRect();
            ox = e.clientX - rect.left; oy = e.clientY - rect.top;
            anchorX = window.innerWidth - host.offsetWidth - 24;
            anchorY = window.innerHeight - host.offsetHeight - 24;
            e.preventDefault();
            document.body.style.userSelect = 'none';
            document.body.style.pointerEvents = 'none';
        });
        let rafId = null;
        window.addEventListener('mousemove', e => {
            if (!dragging) return;
            if (rafId) cancelAnimationFrame(rafId);
            rafId = requestAnimationFrame(() => {
                host.style.transform = `translate(${e.clientX - ox - anchorX}px, ${e.clientY - oy - anchorY}px)`;
                rafId = null;
            });
        });
        window.addEventListener('mouseup', () => {
            dragging = false;
            document.body.style.userSelect = '';
            document.body.style.pointerEvents = '';
        });

        // ── Collapse ──────────────────────────────────────────────────────────────
        const bodyEl = shadow.getElementById('body');
        const toggleBtn = shadow.getElementById('toggle-btn');
        let collapsed = false;
        toggleBtn.addEventListener('click', () => {
            collapsed = !collapsed;
            bodyEl.style.display = collapsed ? 'none' : 'flex';
            toggleBtn.textContent = collapsed ? '+' : '−';
        });

        // ── Helpers ───────────────────────────────────────────────────────────────
        const logEl = shadow.getElementById('log');
        const barEl = shadow.getElementById('bar');
        const percentEl = shadow.getElementById('bar-percent');
        const startBtn = shadow.getElementById('start-btn');
        const cancelBtn = shadow.getElementById('cancel-btn');
        let totalDuration = 0;
        let _cancelled = false;
        cancelBtn.disabled = true;

        function log(msg, cls = '') {
            const span = document.createElement('span');
            span.style.display = 'block';
            if (cls) span.className = cls;
            span.textContent = msg;
            logEl.appendChild(span);
            logEl.scrollTop = logEl.scrollHeight;
        }
        function setProgress(v, total) {
            const pct = ((v / total) * 100).toFixed(1);
            barEl.style.width = pct + '%';
            percentEl.textContent = pct + '%';
        }
        function formatBytes(bytes, decimals = 2) {
            if (bytes === 0) return '0 Bytes';
            const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
            const i = Math.floor(Math.log(bytes) / Math.log(1024));
            return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(decimals))} ${sizes[i]}`;
        }
        async function fetchKey(keyUri, baseUrl) {
            const url = keyUri.startsWith('http') ? keyUri : new URL(keyUri, baseUrl).href;
            return await (await fetch(url)).arrayBuffer();
        }
        async function decryptSegment(buf, keyBuf, iv) {
            const key = await crypto.subtle.importKey('raw', keyBuf, 'AES-CBC', false, ['decrypt']);
            return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf);
        }

        function patchBox(view, fourcc, realDuration) {
            function walk(offset, end) {
                while (offset < end - 8) {
                    const boxSize = view.getUint32(offset);
                    const boxType = view.getUint32(offset + 4);
                    if (boxSize < 8) break;
                    if (boxType === fourcc) {
                        const version = view.getUint8(offset + 8);
                        const dOffset = fourcc === 0x6d766864
                            ? (version === 0 ? offset + 20 : offset + 28)
                            : (version === 0 ? offset + 28 : offset + 36);
                        version === 0
                            ? view.setUint32(dOffset, realDuration)
                            : view.setBigUint64(dOffset, BigInt(realDuration));
                    }
                    if ([0x6d6f6f76, 0x7472616b, 0x6d646961].includes(boxType)) {
                        walk(offset + 8, offset + boxSize);
                    }
                    offset += boxSize;
                }
            }
            walk(0, view.byteLength);
        }

        function getTsDuration(segments) {
            function readPts(buf, offset) {
                return ((buf[offset] & 0x0E) * 0x80000000) +
                    (buf[offset + 1] * 0x1000000) +
                    ((buf[offset + 2] & 0xFE) * 0x8000) +
                    (buf[offset + 3] * 0x80) +
                    ((buf[offset + 4] & 0xFE) >> 1);
            }
            const MAX_PTS = 0x1FFFFFFFF;
            let firstPts = null, prevPts = null, accumulated = 0;
            for (const seg of segments) {
                for (let i = 0; i < seg.byteLength - 188; i += 188) {
                    if (seg[i] !== 0x47) continue;
                    const hasPayload = (seg[i + 3] & 0x10) !== 0;
                    if (!hasPayload) continue;
                    const afLen = (seg[i + 3] & 0x20) ? seg[i + 4] + 1 : 0;
                    const pesStart = i + 4 + afLen;
                    if (pesStart + 14 >= seg.byteLength) continue;
                    if (seg[pesStart] !== 0 || seg[pesStart + 1] !== 0 || seg[pesStart + 2] !== 1) continue;
                    if (!(seg[pesStart + 7] & 0x80)) continue;
                    const pts = readPts(seg, pesStart + 9);
                    if (firstPts === null) { firstPts = pts; prevPts = pts; continue; }
                    accumulated += pts < prevPts - 90000 * 10 ? MAX_PTS - prevPts + pts : pts - prevPts;
                    prevPts = pts;
                }
            }
            if (firstPts === null || prevPts === firstPts) return null;
            return accumulated / 90000;
        }

        function patchAllMdhd(view, totalDuration) {
            function walk(offset, end) {
                while (offset < end - 8) {
                    const boxSize = view.getUint32(offset);
                    const boxType = view.getUint32(offset + 4);
                    if (boxSize < 8) break;
                    if (boxType === 0x6d646864) {
                        const version = view.getUint8(offset + 8);
                        const tsOffset = version === 0 ? offset + 20 : offset + 28;
                        const durOffset = version === 0 ? offset + 24 : offset + 32;
                        const timescale = view.getUint32(tsOffset);
                        const dur = Math.round(totalDuration * timescale);
                        version === 0
                            ? view.setUint32(durOffset, dur)
                            : view.setBigUint64(durOffset, BigInt(dur));
                    }
                    if ([0x6d6f6f76, 0x7472616b, 0x6d646961].includes(boxType)) {
                        walk(offset + 8, offset + boxSize);
                    }
                    offset += boxSize;
                }
            }
            walk(0, view.byteLength);
        }

        // ── Format buttons ────────────────────────────────────────────────────────
        let dlFormat = 'mp4';
        const btnMp4 = shadow.getElementById('fmt-mp4');
        const btnTs = shadow.getElementById('fmt-ts');
        btnMp4.addEventListener('click', () => {
            dlFormat = 'mp4';
            btnMp4.style.background = '#3191f8'; btnMp4.style.color = '#f2f0ed';
            btnTs.style.background = '#191c1e'; btnTs.style.color = '#3191f8';
        });
        btnTs.addEventListener('click', () => {
            dlFormat = 'ts';
            btnTs.style.background = '#3191f8'; btnTs.style.color = '#f2f0ed';
            btnMp4.style.background = '#191c1e'; btnMp4.style.color = '#3191f8';
        });

        // ── Log / copy ────────────────────────────────────────────────────────────
        shadow.getElementById('clear-log-btn').addEventListener('click', () => {
            logEl.innerHTML = '<span class="inf" style="display:block">Ready. Paste links and hit start.</span>';
        });
        shadow.getElementById('copy-log-btn').addEventListener('click', () => {
            const text = [...logEl.querySelectorAll('span')].map(s => s.textContent).join('\n');
            navigator.clipboard.writeText(text).then(() => {
                const btn = shadow.getElementById('copy-log-btn');
                btn.textContent = '✔ Copied!';
                setTimeout(() => btn.textContent = '⎘ Copy Log', 2000);
            });
        });

        // ── Parse m3u8 ────────────────────────────────────────────────────────────
        shadow.getElementById('parse-btn').addEventListener('click', async () => {
            const url = shadow.getElementById('m3u8-url').value.trim();
            if (!url) { log('⚠ No m3u8 URL!', 'err'); return; }
            log('Fetching m3u8…', 'inf');
            try {
                let text = await fetch(url).then(r => r.text());
                let base = url.substring(0, url.lastIndexOf('/') + 1);
                const masterText = text;

                if (text.includes('#EXT-X-STREAM-INF')) {
                    const lines2 = text.split('\n');
                    let bestBw = -1, bestUrl = null;
                    for (let i = 0; i < lines2.length; i++) {
                        if (lines2[i].startsWith('#EXT-X-STREAM-INF')) {
                            const bwMatch = lines2[i].match(/BANDWIDTH=(\d+)/);
                            const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                            const vLine = lines2[i + 1]?.trim();
                            if (vLine && !vLine.startsWith('#') && bw > bestBw) { bestBw = bw; bestUrl = vLine; }
                        }
                    }
                    if (!bestUrl) { log('❌ No variant stream found in master playlist', 'err'); return; }
                    const variantUrl = bestUrl.startsWith('http') ? bestUrl : base + bestUrl;
                    log(`✔ Picked variant: ${bestBw}bps`, 'ok');
                    text = await fetch(variantUrl).then(r => r.text());
                    base = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
                }

                const lines = text.split('\n').map(l => l.trim());
                totalDuration = 0;
                const segments = [];
                const mapLine = lines.find(l => l.startsWith('#EXT-X-MAP'));
                if (mapLine) {
                    const mapUri = mapLine.match(/URI="([^"]+)"/)[1];
                    window._hlsInitUrl = mapUri.startsWith('http') ? mapUri : base + mapUri;
                    log(`✔ fMP4 mode, init: ${window._hlsInitUrl}`, 'ok');
                } else {
                    window._hlsInitUrl = null;
                }
                for (let i = 0; i < lines.length; i++) {
                    if (lines[i].startsWith('#EXTINF:'))
                        totalDuration += parseFloat(lines[i].replace('#EXTINF:', '').split(',')[0]);
                    if (lines[i] && !lines[i].startsWith('#'))
                        segments.push(lines[i].startsWith('http') ? lines[i] : base + lines[i]);
                }
                log(`✔ ${segments.length} segments, real duration: ${totalDuration.toFixed(2)}s`, 'ok');
                shadow.getElementById('links').value = segments.join('\n');
                log(`✔ ${segments.length} segments parsed`, 'ok');

                const keyLine = lines.find(l => l.startsWith('#EXT-X-KEY'));
                if (keyLine) {
                    const uriMatch = keyLine.match(/URI="([^"]+)"/);
                    const ivMatch = keyLine.match(/IV=0x([0-9a-fA-F]+)/);
                    const keyBuf = await fetchKey(uriMatch[1], url);
                    const keyIv = ivMatch
                        ? new Uint8Array(ivMatch[1].match(/../g).map(h => parseInt(h, 16)))
                        : new Uint8Array(16);
                    log(`✔ Key fetched, IV: ${ivMatch ? 'custom' : 'default sequence'}`, 'ok');
                    window._hlsKey = keyBuf; window._hlsIv = keyIv; window._hlsHasKey = true;
                } else {
                    window._hlsKey = null; window._hlsIv = null; window._hlsHasKey = false;
                }

                window._hlsAudioInitUrl = null; window._hlsAudioSegments = null;
                if (masterText && masterText.includes('#EXT-X-MEDIA:TYPE=AUDIO')) {
                    const audioLine = masterText.split('\n').find(l => l.includes('#EXT-X-MEDIA:TYPE=AUDIO'));
                    const audioUriMatch = audioLine?.match(/URI="([^"]+)"/);
                    if (!audioUriMatch) {
                        log('ℹ No audio URI in playlist', 'inf');
                    } else {
                        const audioUrl = audioUriMatch[1].startsWith('http') ? audioUriMatch[1] : url.substring(0, url.lastIndexOf('/') + 1) + audioUriMatch[1];
                        log(`✔ Audio playlist: ${audioUrl}`, 'ok');
                        const audioText = await fetch(audioUrl).then(r => r.text());
                        const aBase = audioUrl.substring(0, audioUrl.lastIndexOf('/') + 1);
                        const aLines = audioText.split('\n').map(l => l.trim());
                        const aMapLine = aLines.find(l => l.startsWith('#EXT-X-MAP'));
                        if (aMapLine) {
                            const aMapUri = aMapLine.match(/URI="([^"]+)"/)[1];
                            window._hlsAudioInitUrl = aMapUri.startsWith('http') ? aMapUri : aBase + aMapUri;
                        }
                        window._hlsAudioSegments = aLines.filter(l => l && !l.startsWith('#')).map(l => l.startsWith('http') ? l : aBase + l);
                        log(`✔ ${window._hlsAudioSegments.length} audio segs found`, 'ok');
                    }
                }
            } catch (e) { log(`❌ ${e.message}`, 'err'); }
        });

        // ── Download ──────────────────────────────────────────────────────────────
        function resetUI() {
            startBtn.disabled = false;
            cancelBtn.disabled = true;
        }

        startBtn.addEventListener('click', async () => {
            const raw = shadow.getElementById('links').value.trim();
            const links = raw.split('\n').map(l => l.trim()).filter(Boolean);
            if (!links.length) { log('⚠ No links!', 'err'); return; }
            if (dlFormat === 'ts' && window._hlsInitUrl) {
                log('⚠ fMP4 segments detected — TS not supported. Switch to MP4.', 'err'); return;
            }

            const filename = shadow.getElementById('filename').value.trim() || 'video.mp4';
            const dlStart = performance.now();
            startBtn.disabled = true;
            _cancelled = false;
            cancelBtn.disabled = false;
            log('─────────────────────', 'fire');
            barEl.style.width = '0%'; percentEl.textContent = '0%';
            totalDuration = 0;
            log(`${links.length} segments. Downloading…`, 'fire');

            try {
                const segmentBuffers = [];
                let initBuf = null;
                if (window._hlsInitUrl) {
                    log('fMP4 mode — fetching init segment…', 'inf');
                    initBuf = new Uint8Array(await (await fetch(window._hlsInitUrl)).arrayBuffer());
                    log(`✔ init: ${formatBytes(initBuf.byteLength, 1)}`, 'ok');
                }

                const BATCH = 5;
                for (let i = 0; i < links.length; i += BATCH) {
                    const slice = links.slice(i, i + BATCH);
                    const results = await Promise.all(slice.map(async (url, j) => {
                        const res = await fetch(url);
                        if (!res.ok) throw new Error(`HTTP ${res.status}`);
                        let buf = await res.arrayBuffer();
                        if (window._hlsHasKey && window._hlsKey) {
                            const iv = window._hlsIv?.byteLength
                                ? window._hlsIv
                                : (() => { const b = new Uint8Array(16); new DataView(b.buffer).setUint32(12, i + j); return b; })();
                            buf = await decryptSegment(buf, window._hlsKey, iv);
                        }
                        return new Uint8Array(buf);
                    }));
                    for (const buf of results) segmentBuffers.push(buf);
                    setProgress(Math.min(i + BATCH, links.length), links.length);
                    log(`✔ segs ${i + 1}–${Math.min(i + BATCH, links.length)}/${links.length}`, 'ok');
                    if (_cancelled) {
                        setProgress(0, links.length);
                        segmentBuffers.length = 0;
                        resetUI(); return;
                    }
                }

                // ── fMP4 path ──
                if (initBuf) {
                    const vLen = initBuf.byteLength + segmentBuffers.reduce((a, c) => a + c.byteLength, 0);
                    const vOut = new Uint8Array(vLen);
                    vOut.set(initBuf, 0); let vOff = initBuf.byteLength;
                    for (const s of segmentBuffers) { vOut.set(s, vOff); vOff += s.byteLength; }
                    triggerDownload(new Blob([vOut], { type: 'video/mp4' }), filename.replace('.mp4', '-v.mp4'));
                    log(`✔ Video: ${formatBytes(vLen, 1)} → "${filename.replace('.mp4', '-v.mp4')}"`, 'ok');

                    if (window._hlsAudioInitUrl && window._hlsAudioSegments?.length) {
                        log('Fetching audio segments…', 'inf');
                        const aInitBuf = new Uint8Array(await (await fetch(window._hlsAudioInitUrl)).arrayBuffer());
                        const aSegs = [];
                        const aBatch = 5;
                        for (let i = 0; i < window._hlsAudioSegments.length; i += aBatch) {
                            const slice = window._hlsAudioSegments.slice(i, i + aBatch);
                            const results = await Promise.all(slice.map(async url => {
                                const r = await fetch(url);
                                if (!r.ok) throw new Error(`Audio seg HTTP ${r.status}`);
                                return new Uint8Array(await r.arrayBuffer());
                            }));
                            for (const buf of results) aSegs.push(buf);
                            log(`✔ audio segs ${i + 1}–${Math.min(i + aBatch, window._hlsAudioSegments.length)}/${window._hlsAudioSegments.length}`, 'ok');
                            if (_cancelled) { segmentBuffers.length = 0; aSegs.length = 0; resetUI(); return; }
                        }
                        const aLen = aInitBuf.byteLength + aSegs.reduce((a, c) => a + c.byteLength, 0);
                        const aOut = new Uint8Array(aLen);
                        aOut.set(aInitBuf, 0); let aOff = aInitBuf.byteLength;
                        for (const s of aSegs) { aOut.set(s, aOff); aOff += s.byteLength; }
                        triggerDownload(new Blob([aOut], { type: 'audio/mp4' }), filename.replace('.mp4', '-a.m4a'));
                        log(`✔ Audio: ${formatBytes(aLen, 1)} → "${filename.replace('.mp4', '-a.m4a')}"`, 'ok');
                        log('ℹ Merge with: ffmpeg -i video.mp4 -i audio.m4a -c copy output.mp4', 'inf');
                    } else {
                        log('ℹ No audio playlist found — video only', 'inf');
                    }
                    setProgress(1, 1);
                    log(`✔ Done`, 'ok');
                    segmentBuffers.length = 0;
                    resetUI(); return;
                }

                // ── TS / remux path ──
                log('Remuxing...', 'inf');
                const mp4Chunks = [];
                const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, baseMediaDecodeTime: 0, remux: true });

                transmuxer.on('data', segment => {
                    if (segment.initSegment?.byteLength > 0) mp4Chunks.push(new Uint8Array(segment.initSegment));
                    if (segment.data?.byteLength > 0) mp4Chunks.push(new Uint8Array(segment.data));
                });

                let doneHandled = false;
                const remuxTimeout = setTimeout(() => {
                    log('⚠ Remux timeout — falling back to raw TS…', 'err');
                    const raw = concatBuffers(segmentBuffers);
                    triggerDownload(new Blob([raw], { type: 'video/mp2t' }), filename.replace('.mp4', '.ts'));
                    segmentBuffers.length = 0;
                    resetUI();
                }, 15000);

                transmuxer.on('done', () => {
                    if (doneHandled) return;
                    const dlEnd = performance.now();
                    doneHandled = true;
                    clearTimeout(remuxTimeout);
                    log('✔ transmuxer done fired', 'ok');
                    log(`⏱ Download took ${((dlEnd - dlStart) / 1000).toFixed(2)}s`, 'fire');

                    if (dlFormat === 'ts') {
                        const raw = concatBuffers(segmentBuffers);
                        triggerDownload(new Blob([raw], { type: 'video/mp2t' }), filename.replace('.mp4', '.ts'));
                        setProgress(1, 1);
                        log(`✔ Total size: ${formatBytes(raw.byteLength, 1)}`, 'ok');
                        log(`✔ Saved as "${filename.replace('.mp4', '.ts')}"`, 'ok');
                        segmentBuffers.length = 0;
                        resetUI();
                    } else {
                        const totalLen = mp4Chunks.reduce((a, c) => a + c.byteLength, 0);
                        const output = new Uint8Array(totalLen);
                        let offset = 0;
                        for (const chunk of mp4Chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
                        const ab2 = output.buffer.slice(0);
                        const view = new DataView(ab2);
                        const realSecs = getTsDuration(segmentBuffers);
                        log(`PTS duration: ${realSecs?.toFixed(2)}s`, 'inf');
                        if (realSecs) totalDuration = realSecs;
                        const realDuration = Math.round(totalDuration * 90000);
                        patchBox(view, 0x6d766864, realDuration);
                        patchBox(view, 0x746b6864, realDuration);
                        patchAllMdhd(view, totalDuration);
                        triggerDownload(new Blob([ab2], { type: 'video/mp4' }), filename);
                        setProgress(1, 1);
                        log(`✔ Total size: ${formatBytes(output.byteLength, 1)}`, 'ok');
                        log(`✔ Saved as "${filename}"`, 'ok');
                        segmentBuffers.length = 0;
                        resetUI();
                    }
                });

                transmuxer.on('error', err => log(`❌ transmuxer error: ${JSON.stringify(err)}`, 'err'));

                for (let i = 0; i < segmentBuffers.length; i++) {
                    try { transmuxer.push(segmentBuffers[i]); }
                    catch (error) { log(`⚠ seg ${i + 1} push error: ${error} — skipping`, 'err'); }
                }
                log('✔ Success push buffer segment.', 'ok');
                log('✔ Final flush called', 'ok');
                transmuxer.flush();

            } catch (err) {
                log(`❌ ${err.message}`, 'err');
                resetUI();
            }
        });

        cancelBtn.addEventListener('click', () => {
            if (!_cancelled) {
                _cancelled = true;
                log('⚠ Cancelled by user', 'err');
                resetUI();
            }
        });

        // ── Utils ─────────────────────────────────────────────────────────────────
        function concatBuffers(bufs) {
            const total = bufs.reduce((a, c) => a + c.byteLength, 0);
            const out = new Uint8Array(total);
            let off = 0;
            for (const b of bufs) { out.set(b, off); off += b.byteLength; }
            return out;
        }

        function triggerDownload(blob, name) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = name;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
    });
})();
