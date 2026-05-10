(async function () {
    'use strict';

    const { FFmpeg } = FFmpegWASM;
    let ffmpeg = new FFmpeg();

    async function loadFFmpeg() {
        if (ffmpeg.loaded) return;
        await ffmpeg.load({
            coreURL: chrome.runtime.getURL('lib/ffmpeg-core.js'),
            wasmURL: chrome.runtime.getURL('lib/ffmpeg-core.wasm'),
        });
    }
    ffmpeg.on('log', ({ type, message }) => {
        if (type === 'stderr' && message?.trim()) log(message, 'err');
    });
    loadFFmpeg().catch(e => console.error('ffmpeg preload fail:', e));

    // ── Load detected URLs from background ────────────────────────────────────
    const params = new URLSearchParams(window.location.search);
    const tab = await chrome.tabs.get(parseInt(params.get('tabId')));
    const STATE_KEY = `state_${tab.id}`;
    const detectedM3u8 = await chrome.runtime.sendMessage({ type: 'GET_URLS', tabId: tab.id }) || [];

    const m3u8Select = document.getElementById('m3u8-select');
    const detectedLabel = document.getElementById('detected-label');

    const logEl = document.getElementById('log');
    const barEl = document.getElementById('bar');
    const percentEl = document.getElementById('bar-percent');
    const startBtn = document.getElementById('start-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    let dlFormat = 'mp4';

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

    const { filename: defaultFilename, concurrency: CONCURRENCY_SETTING, format: defaultFormat } = await new Promise(r =>
        chrome.storage.sync.get({ filename: 'video', concurrency: 5, format: 'mp4' }, r)
    );


    updateDropdown();
    chrome.storage.session.get(STATE_KEY, (s) => {
        const state = s[STATE_KEY];
        if (!state) {
            document.getElementById('filename').value = defaultFilename; // ← add this
            return;
        }
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

    function fetchSegmentViaPage(url, timeoutMs = 60000, retries = 3) {
        return new Promise((resolve, reject) => {
            const attempt = (n) => {
                const id = Math.random().toString(36).slice(2);
                const timer = setTimeout(() => {
                    chrome.runtime.onMessage.removeListener(handler);
                    if (n > 1) { log(`⚠ Retry seg… (${retries - n + 1})`, 'err'); attempt(n - 1); }
                    else reject(new Error(`Segment fetch timeout: ${url}`));
                }, timeoutMs);
                const handler = (msg) => {
                    if (msg.type !== 'FETCH_SEGMENT_RESPONSE' || msg.id !== id) return;
                    clearTimeout(timer);
                    chrome.runtime.onMessage.removeListener(handler);
                    if (msg.error) {
                        if (n > 1) { log(`⚠ Retry seg… (${retries - n + 1})`, 'err'); attempt(n - 1); }
                        else reject(new Error(msg.error));
                    } else resolve(new Uint8Array(msg.arr).buffer);
                };
                chrome.runtime.onMessage.addListener(handler);
                chrome.tabs.sendMessage(tab.id, { type: 'PROXY_SEGMENT', url, id }, () => { });
            };
            attempt(retries);
        });
    }

    function fetchViaPage(url, timeoutMs = 30000) {
        return new Promise((resolve, reject) => {
            const id = Math.random().toString(36).slice(2);
            const timer = setTimeout(() => reject(new Error(`Segment fetch timeout: ${url}`)), timeoutMs);
            const handler = (msg) => {
                if (msg.type !== 'FETCH_M3U8_RESPONSE' || msg.id !== id) return;
                clearTimeout(timer);
                chrome.runtime.onMessage.removeListener(handler);
                msg.error ? reject(new Error(msg.error)) : resolve(msg.text);
            };
            chrome.runtime.onMessage.addListener(handler);
            chrome.tabs.sendMessage(tab.id, { type: 'PROXY_FETCH', url, id }, () => { });
        });
    }

    // ── Reload and Settings ────────────────────────────────────────────────────────
    document.getElementById('reload-btn').addEventListener('click', () => {
        chrome.tabs.reload(tab.id);
    });
    document.getElementById('settings-btn').addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
    });

    // ── Format buttons ────────────────────────────────────────────────────────
    dlFormat = defaultFormat;

    const btnMp4 = document.getElementById('fmt-mp4');
    const btnTs = document.getElementById('fmt-ts');

    // set initial style from settings
    btnMp4.className = dlFormat === 'mp4' ? 'fmt-active' : 'fmt-inactive';
    btnTs.className = dlFormat === 'ts' ? 'fmt-active' : 'fmt-inactive';

    btnMp4.addEventListener('click', () => {
        dlFormat = 'mp4';
        btnMp4.className = 'fmt-active';
        btnTs.className = 'fmt-inactive';
        saveState();
    });
    btnTs.addEventListener('click', () => {
        dlFormat = 'ts';
        btnTs.className = 'fmt-active';
        btnMp4.className = 'fmt-inactive';
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
            const masterBase = url.substring(0, url.lastIndexOf('/') + 1);
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
                    const audioUrl = audioUriMatch[1].startsWith('http') ? audioUriMatch[1] : masterBase + audioUriMatch[1];
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
        const CONCURRENCY = CONCURRENCY_SETTING;
        const raw = document.getElementById('links').value.trim();
        const links = raw.split('\n').map(l => l.trim()).filter(Boolean);
        if (!links.length) { log('⚠ No links!', 'err'); return; }

        // load settings

        const filename = document.getElementById('filename').value.trim() || 'video.mp4';
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

            // ── Handle fMP4 init segment ─────────────────────────────────────
            if (window._hlsInitUrl) {
                log('fMP4 — fetching init…', 'inf');
                const initBuf = new Uint8Array(await fetchSegmentViaPage(window._hlsInitUrl));
                await ffmpeg.writeFile('init.mp4', initBuf);
            }
            if (window._hlsAudioInitUrl) {
                const aInitBuf = new Uint8Array(await fetchSegmentViaPage(window._hlsAudioInitUrl));
                await ffmpeg.writeFile('init_a.mp4', aInitBuf);
            }

            const dlStart = performance.now();
            log(`${links.length} segments. Downloading…`, 'fire');

            // ── Download segments → write to ffmpeg FS ───────────────────────
            const segNames = [];
            const segExt = window._hlsInitUrl ? '.mp4' : '.ts';
            let done = 0;
            const vQueue = links.map((url, i) => async () => {
                if (_cancelled) return;
                let buf = await fetchSegmentViaPage(url);
                if (window._hlsHasKey && window._hlsKey) {
                    const iv = window._hlsIv?.byteLength
                        ? window._hlsIv
                        : (() => { const b = new Uint8Array(16); new DataView(b.buffer).setUint32(12, i + 1); return b; })();
                    buf = await decryptSegment(buf, window._hlsKey, iv);
                }
                const name = `seg${String(i).padStart(6, '0')}${segExt}`;
                await ffmpeg.writeFile(name, new Uint8Array(buf));
                segNames[i] = name;
                setProgress(++done, links.length);
                if (done % CONCURRENCY === 0 || done === links.length) {
                    log(`✔ segs ${done - (done % CONCURRENCY || CONCURRENCY) + 1}–${done}/${links.length}`, 'ok');
                }
            });
            await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (vQueue.length) await vQueue.shift()(); }));
            log(`✔ ${links.length} segs done`, 'ok');

            if (_cancelled) {
                await writable.abort();
                for (const n of segNames) await ffmpeg.deleteFile(n).catch(() => { });
                setProgress(0, links.length); resetUI(); return;
            }

            // ── Download audio segments → ffmpeg FS ─────────────────────────
            const audioSegNames = [];
            if (window._hlsAudioSegments?.length) {
                log(`Downloading ${window._hlsAudioSegments.length} audio segs…`, 'inf');
                const audioSegNames2 = [];
                let aDone = 0;
                const aQueue = window._hlsAudioSegments.map((url, i) => async () => {
                    if (_cancelled) return;
                    const buf = new Uint8Array(await fetchSegmentViaPage(url));
                    const name = `aseg${String(i).padStart(6, '0')}${segExt}`;
                    await ffmpeg.writeFile(name, buf);
                    audioSegNames2[i] = name;
                    setProgress(++aDone, window._hlsAudioSegments.length);
                    if (aDone % CONCURRENCY === 0 || aDone === window._hlsAudioSegments.length) {
                        log(`✔ audio segs ${aDone - (aDone % CONCURRENCY || CONCURRENCY) + 1}–${aDone}/${window._hlsAudioSegments.length}`, 'ok');
                    }
                });
                await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (aQueue.length) await aQueue.shift()(); }));
                audioSegNames.push(...audioSegNames2.filter(Boolean));
            }

            // ── Download done ────────────────────────────────────
            const dlEnd = performance.now();
            log(`⏱ Download segments done in: ${formatDuration(Math.ceil((dlEnd - dlStart) / 1000))}`, 'fire');

            if (_cancelled) {
                await writable.abort();
                for (const n of [...segNames, ...audioSegNames]) await ffmpeg.deleteFile(n).catch(() => { });
                setProgress(0, links.length); resetUI(); return;
            }

            // ── Prepare inputs for ffmpeg ────────────────────────────────────
            const hasAudio = audioSegNames.length > 0;
            if (window._hlsInitUrl) {
                log('Merging fMP4 fragments…', 'inf');
                const vParts = [await ffmpeg.readFile('init.mp4')];
                for (const n of segNames.filter(Boolean)) vParts.push(await ffmpeg.readFile(n));
                const vTotal = vParts.reduce((a, c) => a + c.byteLength, 0);
                const vMerged = new Uint8Array(vTotal);
                let off = 0; for (const p of vParts) { vMerged.set(p, off); off += p.byteLength; }
                await ffmpeg.writeFile('video_merged.mp4', vMerged);

                if (hasAudio) {
                    const aParts = [await ffmpeg.readFile('init_a.mp4')];
                    for (const n of audioSegNames.filter(Boolean)) aParts.push(await ffmpeg.readFile(n));
                    const aTotal = aParts.reduce((a, c) => a + c.byteLength, 0);
                    const aMerged = new Uint8Array(aTotal);
                    let aOff = 0; for (const p of aParts) { aMerged.set(p, aOff); aOff += p.byteLength; }
                    await ffmpeg.writeFile('audio_merged.mp4', aMerged);
                }
            } else {
                const concatList = segNames.map(n => `file '${n}'`).join('\n');
                await ffmpeg.writeFile('concat_v.txt', new TextEncoder().encode(concatList));
                if (hasAudio) {
                    const aConcatList = audioSegNames.map(n => `file '${n}'`).join('\n');
                    await ffmpeg.writeFile('concat_a.txt', new TextEncoder().encode(aConcatList));
                }
            }

            // ── Remux / concat ───────────────────────────────────────────────────────
            const remuxStart = performance.now();
            const outName = dlFormat === 'ts' ? 'output.ts' : 'output.mp4';

            if (dlFormat === 'ts' && !window._hlsInitUrl) {
                // TS = raw concat in JS, skip ffmpeg entirely
                log('Writing TS to disk…', 'inf');
                const writeToDiskStart = performance.now();
                let totalBytes = 0;
                for (const n of segNames.filter(Boolean)) {
                    const chunk = await ffmpeg.readFile(n);
                    await writable.write(chunk);
                    totalBytes += chunk.byteLength;
                }
                // ── Stream output to disk ────────────────────────────────────────
                await writable.close();
                const remuxEnd = performance.now();
                const writeToDiskEnd = remuxEnd;
                log(`⏱ Write to disk done in: ${formatDuration(Math.ceil((writeToDiskEnd - writeToDiskStart) / 1000))}`, 'fire');
                log(`⏱ Total download time: ${formatDuration(Math.ceil((performance.now() - dlStart) / 1000))}`, 'fire');
                log(`✔ Saved → "${fileHandle.name}" (${formatBytes(totalBytes)})`, 'ok');
                saveState();
            } else {
                // MP4 or fMP4 = need ffmpeg
                log('Remuxing with ffmpeg…', 'inf');
                const ffArgs = window._hlsInitUrl
                    ? hasAudio
                        ? ['-i', 'video_merged.mp4', '-i', 'audio_merged.mp4', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', outName]
                        : ['-i', 'video_merged.mp4', '-c', 'copy', outName]
                    : hasAudio
                        ? ['-f', 'concat', '-safe', '0', '-i', 'concat_v.txt', '-f', 'concat', '-safe', '0', '-i', 'concat_a.txt', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', outName]
                        : ['-f', 'concat', '-safe', '0', '-i', 'concat_v.txt', '-c', 'copy', outName];
                try { await ffmpeg.exec(ffArgs); } catch (e) { }
                const remuxEnd = performance.now();
                log(`⏱ Remux done in: ${formatDuration(Math.ceil((remuxEnd - remuxStart) / 1000))}`, 'fire');

                // ── Stream output to disk ────────────────────────────────────────
                const writeToDiskStart = performance.now();
                log('✔ Remux done. Writing to disk…', 'ok');
                let outData;
                try { outData = await ffmpeg.readFile(outName); } catch (e) {
                    await new Promise(r => setTimeout(r, 800));
                    outData = await ffmpeg.readFile(outName);
                }
                if (!outData || (outData.byteLength ?? outData.length) === 0) throw new Error('ffmpeg output empty');
                await writable.write(outData instanceof Uint8Array ? outData : new Uint8Array(outData));
                await writable.close();
                const writeToDiskEnd = performance.now();
                log(`⏱ Write to disk done in: ${formatDuration(Math.ceil((writeToDiskEnd - writeToDiskStart) / 1000))}`, 'fire');
                log(`⏱ Total download time: ${formatDuration(Math.ceil((performance.now() - dlStart) / 1000))}`, 'fire');
                log(`✔ Saved → "${fileHandle.name}" (${formatBytes(outData.byteLength ?? outData.length)})`, 'ok');
                saveState();
            }

            // ── Cleanup ffmpeg FS ────────────────────────────────────────────
            for (const n of [...segNames, ...audioSegNames]) await ffmpeg.deleteFile(n).catch(() => { });
            if (!(dlFormat === 'ts' && !window._hlsInitUrl)) {
                await ffmpeg.deleteFile('concat_v.txt').catch(() => { });
                await ffmpeg.deleteFile('concat_a.txt').catch(() => { });
                await ffmpeg.deleteFile(outName).catch(() => { });
            }
            if (window._hlsAudioInitUrl) await ffmpeg.deleteFile('init_a.mp4').catch(() => { });
            if (window._hlsInitUrl) {
                await ffmpeg.deleteFile('init.mp4').catch(() => { });
                await ffmpeg.deleteFile('video_merged.mp4').catch(() => { });
                if (hasAudio) await ffmpeg.deleteFile('audio_merged.mp4').catch(() => { });
            }

            setProgress(1, 1);
            try { ffmpeg.terminate(); } catch (e) { }
            ffmpeg = new FFmpeg();
            ffmpeg.on('log', ({ type, message }) => {
                if (type === 'stderr' && message?.trim()) log(message, 'err');
            });
            resetUI();

        } catch (err) {
            if (err.name === 'AbortError') { log('⚠ Save cancelled', 'err'); }
            else { log(`❌ ${err?.message || String(err)}`, 'err'); }
            saveState();
            setProgress(1, 1);
            try { ffmpeg.terminate(); } catch (e) { }
            ffmpeg = new FFmpeg();
            ffmpeg.on('log', ({ type, message }) => {
                if (type === 'stderr' && message?.trim()) log(message, 'err');
            });
            resetUI();
        }
    });

    // ── Cancel Download ────────────────────────────────────────────
    cancelBtn.addEventListener('click', () => {
        if (!_cancelled) { _cancelled = true; log('⚠ Cancelled', 'err'); resetUI(); }
    });

})();