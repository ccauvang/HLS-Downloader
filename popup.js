(async function () {
    'use strict';

    // ── Load detected URLs from background ────────────────────────────────────
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const STATE_KEY = `state_${tab.id}`;
    const detectedM3u8 = await chrome.runtime.sendMessage({ type: 'GET_URLS', tabId: tab.id }) || [];

    const m3u8Select = document.getElementById('m3u8-select');
    const detectedLabel = document.getElementById('detected-label');

    function updateDropdown() {
        detectedLabel.textContent = `Detected streams (${detectedM3u8.length})`;
        m3u8Select.innerHTML = '<option value="">— select detected stream —</option>' +
            detectedM3u8.map((u, i) => `<option value="${u}">${i + 1}. ${u.split('/').pop().split('?')[0]}</option>`).join('');
    }
    document.getElementById('links').addEventListener('input', saveState);
    document.getElementById('filename').addEventListener('input', saveState);
    updateDropdown();
    chrome.storage.session.get(STATE_KEY, (s) => {
        const state = s[STATE_KEY];
        if (!state) return;
        if (state.links) document.getElementById('links').value = state.links;
        if (state.filename) document.getElementById('filename').value = state.filename;
        if (state.m3u8Url) document.getElementById('m3u8-url').value = state.m3u8Url;
        if (state.logHtml) logEl.innerHTML = state.logHtml;
        if (state.dlFormat) {
            dlFormat = state.dlFormat;
            btnMp4.className = dlFormat === 'mp4' ? 'fmt-active' : 'fmt-inactive';
            btnTs.className = dlFormat === 'ts' ? 'fmt-active' : 'fmt-inactive';
        }
        if (state.detectedM3u8?.length) {
            detectedM3u8.push(...state.detectedM3u8.filter(u => !detectedM3u8.includes(u)));
            updateDropdown();
        }
    });

    function saveState() {
        chrome.storage.session.set({
            [STATE_KEY]: {
                links: document.getElementById('links').value,
                filename: document.getElementById('filename').value,
                m3u8Url: document.getElementById('m3u8-url').value,
                logHtml: logEl.innerHTML,
                dlFormat,
                detectedM3u8
            }
        });
    }

    m3u8Select.addEventListener('change', () => {
        if (m3u8Select.value) document.getElementById('m3u8-url').value = m3u8Select.value;
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    const logEl = document.getElementById('log');
    const barEl = document.getElementById('bar');
    const percentEl = document.getElementById('bar-percent');
    const startBtn = document.getElementById('start-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    let totalDuration = 0;
    let _cancelled = false;

    function log(msg, cls = '') {
        const span = document.createElement('span');
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
    function resetUI() { startBtn.disabled = false; cancelBtn.disabled = true; }
    function concatBuffers(bufs) {
        const total = bufs.reduce((a, c) => a + c.byteLength, 0);
        const out = new Uint8Array(total); let off = 0;
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
                    version === 0 ? view.setUint32(dOffset, realDuration) : view.setBigUint64(dOffset, BigInt(realDuration));
                }
                if ([0x6d6f6f76, 0x7472616b, 0x6d646961].includes(boxType)) walk(offset + 8, offset + boxSize);
                offset += boxSize;
            }
        }
        walk(0, view.byteLength);
    }
    function getTsDuration(segments) {
        function readPts(buf, offset) {
            return ((buf[offset] & 0x0E) * 0x80000000) + (buf[offset + 1] * 0x1000000) +
                ((buf[offset + 2] & 0xFE) * 0x8000) + (buf[offset + 3] * 0x80) + ((buf[offset + 4] & 0xFE) >> 1);
        }
        const MAX_PTS = 0x1FFFFFFFF;
        let firstPts = null, prevPts = null, accumulated = 0;
        for (const seg of segments) {
            for (let i = 0; i < seg.byteLength - 188; i += 188) {
                if (seg[i] !== 0x47) continue;
                if (!(seg[i + 3] & 0x10)) continue;
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
                    version === 0 ? view.setUint32(durOffset, dur) : view.setBigUint64(durOffset, BigInt(dur));
                }
                if ([0x6d6f6f76, 0x7472616b, 0x6d646961].includes(boxType)) walk(offset + 8, offset + boxSize);
                offset += boxSize;
            }
        }
        walk(0, view.byteLength);
    }

    function fetchSegmentViaPage(url) {
        return new Promise((resolve, reject) => {
            const id = Math.random().toString(36).slice(2);
            const handler = (msg) => {
                if (msg.type !== 'FETCH_SEGMENT_RESPONSE' || msg.id !== id) return;
                chrome.runtime.onMessage.removeListener(handler);
                msg.error ? reject(new Error(msg.error)) : resolve(new Uint8Array(msg.arr).buffer);
            };
            chrome.runtime.onMessage.addListener(handler);
            chrome.tabs.sendMessage(tab.id, { type: 'PROXY_SEGMENT', url, id });
        });
    }

    function fetchViaPage(url) {
        return new Promise((resolve, reject) => {
            const id = Math.random().toString(36).slice(2);
            const handler = (msg) => {
                if (msg.type !== 'FETCH_M3U8_RESPONSE' || msg.id !== id) return;
                chrome.runtime.onMessage.removeListener(handler);
                msg.error ? reject(new Error(msg.error)) : resolve(msg.text);
            };
            chrome.runtime.onMessage.addListener(handler);
            chrome.tabs.sendMessage(tab.id, { type: 'PROXY_FETCH', url, id });
        });
    }

    // ── Format buttons ────────────────────────────────────────────────────────
    let dlFormat = 'mp4';
    const btnMp4 = document.getElementById('fmt-mp4');
    const btnTs = document.getElementById('fmt-ts');
    btnMp4.addEventListener('click', () => {
        dlFormat = 'mp4';
        btnMp4.className = 'fmt-active'; btnTs.className = 'fmt-inactive';
        saveState();
    });
    btnTs.addEventListener('click', () => {
        dlFormat = 'ts';
        btnTs.className = 'fmt-active'; btnMp4.className = 'fmt-inactive';
        saveState();
    });

    // ── Log buttons ───────────────────────────────────────────────────────────
    document.getElementById('clear-log-btn').addEventListener('click', () => {
        logEl.innerHTML = '<span class="inf">Ready. Paste links and hit start.</span>';
        saveState();
    });
    document.getElementById('copy-log-btn').addEventListener('click', () => {
        const text = [...logEl.querySelectorAll('span')].map(s => s.textContent).join('\n');
        navigator.clipboard.writeText(text).then(() => {
            const btn = document.getElementById('copy-log-btn');
            btn.textContent = '✔ Copied!';
            setTimeout(() => btn.textContent = '⎘ Copy Log', 2000);
        });
    });

    // ── Parse ─────────────────────────────────────────────────────────────────
    document.getElementById('parse-btn').addEventListener('click', async () => {
        const url = document.getElementById('m3u8-url').value.trim();
        if (!url) { log('⚠ No m3u8 URL!', 'err'); return; }
        log('Fetching m3u8…', 'inf');
        try {
            let text = await fetchViaPage(url);
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
                if (!bestUrl) { log('❌ No variant stream found', 'err'); return; }
                const variantUrl = bestUrl.startsWith('http') ? bestUrl : base + bestUrl;
                log(`✔ Picked variant: ${bestBw}bps`, 'ok');
                text = await fetchViaPage(variantUrl);
                base = variantUrl.substring(0, variantUrl.lastIndexOf('/') + 1);
            }

            const lines = text.split('\n').map(l => l.trim());
            totalDuration = 0;
            const segments = [];
            const mapLine = lines.find(l => l.startsWith('#EXT-X-MAP'));
            if (mapLine) {
                const mapUri = mapLine.match(/URI="([^"]+)"/)[1];
                window._hlsInitUrl = mapUri.startsWith('http') ? mapUri : base + mapUri;
                log(`✔ fMP4 mode`, 'ok');
            } else { window._hlsInitUrl = null; }

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXTINF:'))
                    totalDuration += parseFloat(lines[i].replace('#EXTINF:', '').split(',')[0]);
                if (lines[i] && !lines[i].startsWith('#'))
                    segments.push(lines[i].startsWith('http') ? lines[i] : base + lines[i]);
            }
            log(`✔ ${segments.length} segments, ${totalDuration.toFixed(2)}s`, 'ok');
            document.getElementById('links').value = segments.join('\n');

            const keyLine = lines.find(l => l.startsWith('#EXT-X-KEY'));
            if (keyLine) {
                const uriMatch = keyLine.match(/URI="([^"]+)"/);
                const ivMatch = keyLine.match(/IV=0x([0-9a-fA-F]+)/);
                const keyBuf = await fetchKey(uriMatch[1], url);
                const keyIv = ivMatch ? new Uint8Array(ivMatch[1].match(/../g).map(h => parseInt(h, 16))) : new Uint8Array(16);
                log(`✔ Key fetched, IV: ${ivMatch ? 'custom' : 'default'}`, 'ok');
                window._hlsKey = keyBuf; window._hlsIv = keyIv; window._hlsHasKey = true;
            } else { window._hlsKey = null; window._hlsIv = null; window._hlsHasKey = false; }

            window._hlsAudioInitUrl = null; window._hlsAudioSegments = null;
            if (masterText?.includes('#EXT-X-MEDIA:TYPE=AUDIO')) {
                const audioLine = masterText.split('\n').find(l => l.includes('#EXT-X-MEDIA:TYPE=AUDIO'));
                const audioUriMatch = audioLine?.match(/URI="([^"]+)"/);
                if (audioUriMatch) {
                    const audioUrl = audioUriMatch[1].startsWith('http') ? audioUriMatch[1] : url.substring(0, url.lastIndexOf('/') + 1) + audioUriMatch[1];
                    const audioText = await fetchViaPage(audioUrl);
                    const aBase = audioUrl.substring(0, audioUrl.lastIndexOf('/') + 1);
                    const aLines = audioText.split('\n').map(l => l.trim());
                    const aMapLine = aLines.find(l => l.startsWith('#EXT-X-MAP'));
                    if (aMapLine) {
                        const aMapUri = aMapLine.match(/URI="([^"]+)"/)[1];
                        window._hlsAudioInitUrl = aMapUri.startsWith('http') ? aMapUri : aBase + aMapUri;
                    }
                    window._hlsAudioSegments = aLines.filter(l => l && !l.startsWith('#')).map(l => l.startsWith('http') ? l : aBase + l);
                    log(`✔ ${window._hlsAudioSegments.length} audio segs`, 'ok');
                }
            }
            saveState();
        } catch (e) { log(`❌ ${e.message}`, 'err'); }
    });

    // ── Download ──────────────────────────────────────────────────────────────
    startBtn.addEventListener('click', async () => {
        const raw = document.getElementById('links').value.trim();
        const links = raw.split('\n').map(l => l.trim()).filter(Boolean);
        if (!links.length) { log('⚠ No links!', 'err'); return; }
        if (dlFormat === 'ts' && window._hlsInitUrl) { log('⚠ fMP4 — switch to MP4', 'err'); return; }

        const filename = document.getElementById('filename').value.trim() || 'video.mp4';
        const dlStart = performance.now();
        startBtn.disabled = true; _cancelled = false; cancelBtn.disabled = false;
        log('─────────────────────', 'fire');
        barEl.style.width = '0%'; percentEl.textContent = '0%'; totalDuration = 0;
        log(`${links.length} segments. Downloading…`, 'fire');

        try {
            const segmentBuffers = [];
            let initBuf = null;
            if (window._hlsInitUrl) {
                log('fMP4 — fetching init…', 'inf');
                initBuf = new Uint8Array(await fetchSegmentViaPage(window._hlsInitUrl));
                log(`✔ init: ${formatBytes(initBuf.byteLength, 1)}`, 'ok');
            }

            const BATCH = 5;
            for (let i = 0; i < links.length; i += BATCH) {
                const slice = links.slice(i, i + BATCH);
                const results = await Promise.all(slice.map(async (url, j) => {
                    let buf = await fetchSegmentViaPage(url);
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
                if (_cancelled) { setProgress(0, links.length); segmentBuffers.length = 0; resetUI(); return; }
            }

            if (initBuf) {
                const vLen = initBuf.byteLength + segmentBuffers.reduce((a, c) => a + c.byteLength, 0);
                const vOut = new Uint8Array(vLen);
                vOut.set(initBuf, 0); let vOff = initBuf.byteLength;
                for (const s of segmentBuffers) { vOut.set(s, vOff); vOff += s.byteLength; }
                triggerDownload(new Blob([vOut], { type: 'video/mp4' }), filename.replace('.mp4', '-v.mp4'));
                log(`✔ Video: ${formatBytes(vLen, 1)}`, 'ok');
                if (window._hlsAudioInitUrl && window._hlsAudioSegments?.length) {
                    const aInitBuf = new Uint8Array(await fetchSegmentViaPage(url));
                    const aSegs = [];
                    for (let i = 0; i < window._hlsAudioSegments.length; i += 5) {
                        const results = await Promise.all(window._hlsAudioSegments.slice(i, i + 5).map(async url => new Uint8Array(await (await fetchSegmentViaPage(url)).arrayBuffer())));
                        for (const buf of results) aSegs.push(buf);
                        if (_cancelled) { segmentBuffers.length = 0; aSegs.length = 0; resetUI(); return; }
                    }
                    const aLen = aInitBuf.byteLength + aSegs.reduce((a, c) => a + c.byteLength, 0);
                    const aOut = new Uint8Array(aLen); aOut.set(aInitBuf, 0); let aOff = aInitBuf.byteLength;
                    for (const s of aSegs) { aOut.set(s, aOff); aOff += s.byteLength; }
                    triggerDownload(new Blob([aOut], { type: 'audio/mp4' }), filename.replace('.mp4', '-a.m4a'));
                    log(`✔ Audio: ${formatBytes(aLen, 1)}`, 'ok');
                    log('ℹ ffmpeg -i video.mp4 -i audio.m4a -c copy output.mp4', 'inf');
                }
                setProgress(1, 1); log('✔ Done', 'ok'); segmentBuffers.length = 0; resetUI(); return;
            }

            log('Remuxing...', 'inf');
            const mp4Chunks = [];
            const transmuxer = new muxjs.mp4.Transmuxer({ keepOriginalTimestamps: true, baseMediaDecodeTime: 0, remux: true });

            transmuxer.on('data', seg => {
                if (seg.initSegment?.byteLength > 0) mp4Chunks.push(new Uint8Array(seg.initSegment));
                if (seg.data?.byteLength > 0) mp4Chunks.push(new Uint8Array(seg.data));
            });

            let doneHandled = false;
            const remuxTimeout = setTimeout(() => {
                log('⚠ Timeout — raw TS fallback', 'err');
                triggerDownload(new Blob([concatBuffers(segmentBuffers)], { type: 'video/mp2t' }), filename.replace('.mp4', '.ts'));
                segmentBuffers.length = 0; resetUI();
            }, 15000);

            transmuxer.on('done', () => {
                if (doneHandled) return;
                const dlEnd = performance.now();
                doneHandled = true; clearTimeout(remuxTimeout);
                log('✔ transmuxer done', 'ok');
                log(`⏱ ${((dlEnd - dlStart) / 1000).toFixed(2)}s`, 'fire');
                if (dlFormat === 'ts') {
                    const raw = concatBuffers(segmentBuffers);
                    triggerDownload(new Blob([raw], { type: 'video/mp2t' }), filename.replace('.mp4', '.ts'));
                    setProgress(1, 1);
                    log(`✔ ${formatBytes(raw.byteLength, 1)} → "${filename.replace('.mp4', '.ts')}"`, 'ok');
                    segmentBuffers.length = 0; resetUI();
                } else {
                    const totalLen = mp4Chunks.reduce((a, c) => a + c.byteLength, 0);
                    const output = new Uint8Array(totalLen); let offset = 0;
                    for (const chunk of mp4Chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
                    const ab2 = output.buffer.slice(0);
                    const view = new DataView(ab2);
                    const realSecs = getTsDuration(segmentBuffers);
                    if (realSecs) totalDuration = realSecs;
                    const realDuration = Math.round(totalDuration * 90000);
                    patchBox(view, 0x6d766864, realDuration);
                    patchBox(view, 0x746b6864, realDuration);
                    patchAllMdhd(view, totalDuration);
                    triggerDownload(new Blob([ab2], { type: 'video/mp4' }), filename);
                    setProgress(1, 1);
                    log(`✔ ${formatBytes(output.byteLength, 1)} → "${filename}"`, 'ok');
                    segmentBuffers.length = 0; resetUI();
                }
            });
            transmuxer.on('error', err => log(`❌ ${JSON.stringify(err)}`, 'err'));
            for (let i = 0; i < segmentBuffers.length; i++) {
                try { transmuxer.push(segmentBuffers[i]); }
                catch (e) { log(`⚠ seg ${i + 1} skip: ${e}`, 'err'); }
            }
            log('✔ Push done', 'ok');
            transmuxer.flush();

        } catch (err) { log(`❌ ${err.message}`, 'err'); resetUI(); }
    });

    cancelBtn.addEventListener('click', () => {
        if (!_cancelled) { _cancelled = true; log('⚠ Cancelled', 'err'); resetUI(); }
    });

})();