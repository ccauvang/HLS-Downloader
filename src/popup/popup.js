(async function () {
    'use strict';

    const { FFmpeg } = FFmpegWASM;
    const ffmpeg = new FFmpeg();

    async function loadFFmpeg() {
        if (ffmpeg.loaded) return;
        await ffmpeg.load({
            coreURL: chrome.runtime.getURL('lib/ffmpeg-core.js'),
            wasmURL: chrome.runtime.getURL('lib/ffmpeg-core.wasm'),
        });
    }
    loadFFmpeg().catch(e => console.error('ffmpeg preload fail:', e));

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
    function formatDuration(seconds) {
        const d = Math.floor(seconds / 86400);
        const h = Math.floor((seconds % 86400) / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
        if (h > 0) return `${h}h ${m}m ${s}s`;
        if (m > 0) return `${m}m ${s}s`;
        return `${s}s`;
    }
    function resetUI() {
        startBtn.disabled = false;
        cancelBtn.disabled = true;
    }

    async function fetchKey(keyUri, baseUrl) {
        const url = keyUri.startsWith('http') ? keyUri : new URL(keyUri, baseUrl).href;
        return await (await fetch(url)).arrayBuffer();
    }
    async function decryptSegment(buf, keyBuf, iv) {
        const key = await crypto.subtle.importKey('raw', keyBuf, 'AES-CBC', false, ['decrypt']);
        return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf);
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
            log(`✔ ${segments.length} segments, ${formatDuration(totalDuration)}`, 'ok');
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

        const filename = document.getElementById('filename').value.trim() || 'video.mp4';
        const dlStart = performance.now();
        startBtn.disabled = true; _cancelled = false; cancelBtn.disabled = false;
        log('─────────────────────', 'fire');
        barEl.style.width = '0%'; percentEl.textContent = '0%';

        try {
            // ── Pick save location ───────────────────────────────────────────
            const ext = dlFormat === 'ts' ? '.ts' : '.mp4';
            const baseName = filename.replace(/\.(mp4|ts)$/i, '');
            const fileHandle = await window.showSaveFilePicker({
                suggestedName: baseName + ext,
                types: dlFormat === 'ts'
                    ? [{ description: 'TS Video', accept: { 'video/mp2t': ['.ts'] } }]
                    : [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }]
            });
            const writable = await fileHandle.createWritable();

            // ── Load ffmpeg ──────────────────────────────────────────────────
            await loadFFmpeg();
            ffmpeg.on('log', ({ type, message }) => {
                if (type === 'error' && message?.trim()) log(message, 'err');
            });

            log(`${links.length} segments. Downloading…`, 'fire');

            // ── Download segments → write to ffmpeg FS ───────────────────────
            const segNames = [];
            const BATCH = 3;
            for (let i = 0; i < links.length; i += BATCH) {
                if (_cancelled) break;
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
                for (let j = 0; j < results.length; j++) {
                    const name = `seg${String(i + j).padStart(6, '0')}.ts`;
                    await ffmpeg.writeFile(name, results[j]);
                    segNames.push(name);
                }
                setProgress(Math.min(i + BATCH, links.length), links.length);
                log(`✔ segs ${i + 1}–${Math.min(i + BATCH, links.length)}/${links.length}`, 'ok');
            }

            if (_cancelled) {
                await writable.abort();
                for (const n of segNames) await ffmpeg.deleteFile(n).catch(() => { });
                setProgress(0, links.length); resetUI(); return;
            }

            // ── Write concat list ────────────────────────────────────────────
            const concatList = segNames.map(n => `file '${n}'`).join('\n');
            await ffmpeg.writeFile('concat.txt', new TextEncoder().encode(concatList));

            // ── Handle fMP4 init segment ─────────────────────────────────────
            if (window._hlsInitUrl) {
                log('fMP4 — fetching init…', 'inf');
                const initBuf = new Uint8Array(await fetchSegmentViaPage(window._hlsInitUrl));
                await ffmpeg.writeFile('init.mp4', initBuf);
            }

            // ── Remux with ffmpeg ────────────────────────────────────────────
            log('Remuxing with ffmpeg…', 'inf');
            const outName = dlFormat === 'ts' ? 'output.ts' : 'output.mp4';

            let ret;
            try {
                ret = await ffmpeg.exec([
                    '-f', 'concat', '-safe', '0', '-i', 'concat.txt',
                    '-c', 'copy',
                    outName
                ]);
            } catch (e) {
                // try read anyway
            }

            log('✔ Remux done. Writing to disk…', 'ok');

            // ── Stream output to disk ────────────────────────────────────────
            let outData;
            try {
                outData = await ffmpeg.readFile(outName);
            } catch (e) {
                await new Promise(r => setTimeout(r, 800));
                outData = await ffmpeg.readFile(outName);
            }
            if (!outData || (outData.byteLength ?? outData.length) === 0) {
                throw new Error('ffmpeg output empty');
            }


            await writable.write(outData instanceof Uint8Array ? outData : new Uint8Array(outData));
            await writable.close();

            const dlEnd = performance.now();
            log(`⏱ Download in: ${formatDuration(((dlEnd - dlStart) / 1000).toFixed(2))}`, 'fire');
            log(`✔ Saved → "${fileHandle.name}"`, 'ok');
            saveState();

            // ── Cleanup ffmpeg FS ────────────────────────────────────────────
            for (const n of segNames) await ffmpeg.deleteFile(n).catch(() => { });
            await ffmpeg.deleteFile('concat.txt').catch(() => { });
            await ffmpeg.deleteFile(outName).catch(() => { });

            setProgress(1, 1); resetUI();

        } catch (err) {
            if (err.name === 'AbortError') { log('⚠ Save cancelled', 'err'); }
            else { log(`❌ ${err.message}`, 'err'); }
            resetUI();
        }
    });

    cancelBtn.addEventListener('click', () => {
        if (!_cancelled) { _cancelled = true; log('⚠ Cancelled', 'err'); resetUI(); }
    });

})();