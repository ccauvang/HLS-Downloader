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
        if (type === 'stderr' && message?.trim() && shouldLogFfmpeg(message)) log(message.trim(), 'inf');
    });
    loadFFmpeg().catch(e => console.error('ffmpeg preload fail:', e));

    // ── Preload history & settings assets ────────────────────────────────────
    let historyBodyHTML = null;
    let settingsBodyHTML = null;
    let historyScriptLoaded = false;
    let settingsScriptLoaded = false;

    (async () => {
        const [histRes, setRes] = await Promise.all([
            fetch(chrome.runtime.getURL('src/history/history.html')),
            fetch(chrome.runtime.getURL('src/settings/settings.html'))
        ]);
        const [histHtml, setHtml] = await Promise.all([histRes.text(), setRes.text()]);
        const parser = new DOMParser();
        historyBodyHTML = parser.parseFromString(histHtml, 'text/html').getElementById('body').innerHTML;
        settingsBodyHTML = parser.parseFromString(setHtml, 'text/html').getElementById('body').innerHTML;

        // inject CSS once
        for (const [id, href] of [
            ['history-css', 'src/history/history.css'],
            ['settings-css', 'src/settings/settings.css']
        ]) {
            if (!document.getElementById(id)) {
                const link = document.createElement('link');
                link.id = id; link.rel = 'stylesheet';
                link.href = chrome.runtime.getURL(href);
                document.head.appendChild(link);
            }
        }
    })();

    // ── Load detected URLs from background ────────────────────────────────────
    const params = new URLSearchParams(window.location.search);
    const tab = await chrome.tabs.get(parseInt(params.get('tabId')));
    const STATE_KEY = `state_${tab.id}`;
    const detectedM3u8 = await chrome.runtime.sendMessage({ type: 'GET_URLS', tabId: tab.id }) || [];
    const m3u8SelectEl = document.getElementById('m3u8-select');
    const m3u8Selected = document.getElementById('m3u8-selected');
    const m3u8Options = document.getElementById('m3u8-options');
    const detectedLabel = document.getElementById('detected-label');
    const logEl = document.getElementById('log');
    const barEl = document.getElementById('bar');
    const percentEl = document.getElementById('bar-percent');
    const startBtn = document.getElementById('start-btn');
    const cancelBtn = document.getElementById('cancel-btn');
    const btnMp4 = document.getElementById('fmt-mp4');
    const btnTs = document.getElementById('fmt-ts');
    let m3u8Value = '';
    let dlFormat = 'mp4';

    function updateDropdown() {
        detectedLabel.textContent = `Detected streams (${detectedM3u8.length})`;
        m3u8Options.innerHTML = '';

        if (!detectedM3u8.length) {
            m3u8Selected.textContent = '— no streams detected yet —';
            m3u8Value = '';
            return;
        }

        detectedM3u8.forEach((entry, i) => {
            const url = typeof entry === 'string' ? entry : entry.url;
            const label = typeof entry === 'string' ? '' : ` — ${entry.label}`;
            const shortUrl = url.length > 35 ? url.slice(0, 35) + '...' : url;
            const opt = document.createElement('div');
            opt.className = 'custom-option';
            opt.textContent = `${i + 1}. ${shortUrl}${label}`;
            opt.title = url;
            opt.addEventListener('click', (e) => {
                e.stopPropagation();
                m3u8Value = url;
                m3u8Selected.textContent = opt.textContent;
                document.getElementById('m3u8-url').value = url;
                m3u8Options.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
                opt.classList.add('selected');
                m3u8SelectEl.classList.remove('open');
            });
            m3u8Options.appendChild(opt);
        });
    }

    document.getElementById('links').addEventListener('input', saveState);
    document.getElementById('filename').addEventListener('input', saveState);

    chrome.runtime.sendMessage({ type: 'SET_ACTIVE_TAB', tabId: tab.id });
    window.addEventListener('unload', () => {
        chrome.runtime.sendMessage({ type: 'UNSET_ACTIVE_TAB', tabId: tab.id });
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

    let { filename: defaultFilename, concurrency: CONCURRENCY_SETTING, format: defaultFormat } = await new Promise(r =>
        chrome.storage.sync.get({ filename: 'video', concurrency: 5, format: 'mp4' }, r)
    );

    document.getElementById('first-log').textContent =
        `Ready. Concurrency: ${CONCURRENCY_SETTING} | On: ${new URL(tab.url).hostname}\nTab ID: ${tab.id} | v2.0`;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'SETTINGS_UPDATED') return;
        const { concurrency, format } = msg.changes;
        if (concurrency) CONCURRENCY_SETTING = concurrency.newValue;
        if (format) {
            dlFormat = format.newValue;
            btnMp4.className = dlFormat === 'mp4' ? 'fmt-active' : 'fmt-inactive';
            btnTs.className = dlFormat === 'ts' ? 'fmt-active' : 'fmt-inactive';
        }

        document.getElementById('first-log').textContent =
            `Ready. Concurrency: ${CONCURRENCY_SETTING} | On: ${new URL(tab.url).hostname}\nTab ID: ${tab.id} | v2.0`;
    });

    updateDropdown();

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'HLS_DETECTED') return;
        if (msg.tabId !== tab.id) return;
        if (detectedM3u8.find(e => (typeof e === 'object' ? e.url : e) === msg.url)) return;
        // verify via page context before showing
        detectStreamInfo(msg.url).then(info => {
            if (!info) return;
            if (!detectedM3u8.find(e => e.url === info.url)) {
                detectedM3u8.push(info);
                updateDropdown();
            }
        }).catch(() => { });
    });

    chrome.storage.session.get(STATE_KEY, (s) => {
        const state = s[STATE_KEY];
        if (!state) {
            document.getElementById('filename').value = defaultFilename;
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
        detectedM3u8.push(...state.detectedM3u8.filter(e => {
            const url = typeof e === 'string' ? e : e.url;
            return !detectedM3u8.find(x => (typeof x === 'string' ? x : x.url) === url);
        }));
    });

    // ── Helpers ───────────────────────────────────────────────────────────────
    let totalDuration = 0;
    let _cancelled = false;

    async function saveHistory(entry) {
        const { history = {} } = await chrome.storage.local.get('history');
        const id = Math.random().toString(36).slice(2, 10);
        history[id] = entry;
        await chrome.storage.local.set({ history });
    }

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

    function shouldLogFfmpeg(msg) {
        const m = msg.trim();
        const suppress = [
            'frame=', 'built with', 'configuration:', 'lib',
            'Stream mapping', 'Stream #', 'Input #', 'Output #',
            'Duration', 'Metadata', 'encoder', 'Error closing file',
            '[mp4', '[mov', '[matroska', 'Non-monotonous',
            '  '
        ];
        return !suppress.some(s => m.startsWith(s));
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

    async function detectStreamInfo(url) {
        const text = await fetchViaPage(url);
        if (!text.trimStart().startsWith('#EXTM3U')) return null;

        const lines = text.split('\n').map(l => l.trim());
        const isMaster = lines.some(l => l.startsWith('#EXT-X-STREAM-INF'));

        if (isMaster) {
            let bestBw = -1, bestUrl = null;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
                    const bwMatch = lines[i].match(/BANDWIDTH=(\d+)/);
                    const bw = bwMatch ? parseInt(bwMatch[1]) : 0;
                    const vLine = lines[i + 1]?.trim();
                    if (vLine && !vLine.startsWith('#') && bw > bestBw) {
                        bestBw = bw; bestUrl = vLine;
                    }
                }
            }
            if (bestUrl) {
                const base = url.substring(0, url.lastIndexOf('/') + 1);
                const variantUrl = bestUrl.startsWith('http') ? bestUrl : base + bestUrl;
                try {
                    const variantText = await fetchViaPage(variantUrl);
                    const info = parseMediaPlaylist(variantText);
                    return {
                        url, isMaster: true,
                        label: `${formatDuration(Math.ceil(info.duration))} | ${info.segments} segs | master`,
                        cachedText: text,
                        variantUrl,
                        cachedVariantText: variantText
                    };
                } catch (e) {
                    return { url, isMaster: true, label: 'Master playlist', cachedText: text, variantUrl: null, cachedVariantText: null };
                }
            }
            return { url, isMaster: true, label: 'Master playlist', cachedText: text, variantUrl: null, cachedVariantText: null };
        }

        const info = parseMediaPlaylist(text);
        return {
            url, isMaster: false,
            label: `${formatDuration(Math.ceil(info.duration))} | ${info.segments} segs`,
            cachedText: text,
            variantUrl: null,
            cachedVariantText: null
        };
    }

    function parseMediaPlaylist(text) {
        const lines = text.split('\n');
        let duration = 0, segments = 0;
        for (const l of lines) {
            if (l.trimStart().startsWith('#EXTINF:')) {
                duration += parseFloat(l.trim().slice(8).split(',')[0]) || 0;
                segments++;
            }
        }
        return { duration, segments };
    }

    // ── View switching ────────────────────────────────────────────────────────
    const mainBody = document.getElementById('body');

    function showView(view) {
        // hide main body content
        [...mainBody.children].forEach(el => el.style.display = view === 'main' ? '' : 'none');

        // update active btn
        document.getElementById('home-btn').classList.toggle('active', view === 'main');
        document.getElementById('history-btn').classList.toggle('active', view === 'history');
        document.getElementById('settings-btn').classList.toggle('active', view === 'settings');

        // remove old injected view
        document.getElementById('injected-view')?.remove();

        if (view === 'main') return;

        const div = document.createElement('div');
        div.id = 'injected-view';
        div.innerHTML = view === 'history' ? historyBodyHTML : settingsBodyHTML;
        mainBody.appendChild(div);
    }

    document.getElementById('home-btn').classList.add('active');

    document.getElementById('home-btn').addEventListener('click', () => showView('main'));

    document.getElementById('history-btn').addEventListener('click', () => {
        if (!historyBodyHTML) return;
        showView('history');
        if (!historyScriptLoaded) {
            const script = document.createElement('script');
            script.src = chrome.runtime.getURL('src/history/history.js');
            script.onload = () => window.hlsHistoryLoad?.(); // wait for script then load
            document.body.appendChild(script);
            historyScriptLoaded = true;
        } else {
            window.hlsHistoryLoad?.();
        }
    });

    document.getElementById('settings-btn').addEventListener('click', () => {
        if (!settingsBodyHTML) return;
        showView('settings');
        if (!settingsScriptLoaded) {
            const script = document.createElement('script');
            script.src = chrome.runtime.getURL('src/settings/settings.js');
            script.onload = () => window.hlsSettingsInit?.();
            document.body.appendChild(script);
            settingsScriptLoaded = true;
        } else {
            window.hlsSettingsInit?.();
        }
    });

    // ── Dropdown and Reload───────────────────────────────────────────────────────────
    m3u8SelectEl.addEventListener('click', () => {
        m3u8SelectEl.classList.toggle('open');
    });

    document.addEventListener('click', (e) => {
        if (!m3u8SelectEl.contains(e.target)) m3u8SelectEl.classList.remove('open');
    });

    document.getElementById('reload-btn').addEventListener('click', () => {
        chrome.tabs.reload(tab.id);
        detectedM3u8.length = 0;
        updateDropdown();
    });

    // ── Parse ─────────────────────────────────────────────────────────────────
    document.getElementById('parse-btn').addEventListener('click', async () => {
        const url = document.getElementById('m3u8-url').value.trim();
        if (!url) { log('⚠ No m3u8 URL!', 'err'); return; }

        // check cache first
        const cached = detectedM3u8.find(e => typeof e === 'object' && e.url === url);
        const masterBase = url.substring(0, url.lastIndexOf('/') + 1);
        let text, base, masterText;

        log('Fetching m3u8…', 'inf');
        try {

            if (cached?.cachedText) {
                log('✔ Using cached playlist', 'ok');
                text = cached.cachedText;
                base = url.substring(0, url.lastIndexOf('/') + 1);

                // if master and has cached variant
                if (cached.isMaster && cached.cachedVariantText) {
                    log('✔ Using cached variant', 'ok');
                    text = cached.cachedVariantText;
                    base = cached.variantUrl.substring(0, cached.variantUrl.lastIndexOf('/') + 1);
                } else if (cached.isMaster && !cached.cachedVariantText) {
                    // master but no variant cached, fetch normally
                    text = await fetchViaPage(url);
                    base = masterBase;
                }
            } else {
                text = await fetchViaPage(url);
                base = masterBase;
                masterText = text;
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

    // ── Log buttons ───────────────────────────────────────────────────────────
    document.getElementById('clear-log-btn').addEventListener('click', () => {
        logEl.innerHTML = `<span class="inf">Ready. Concurrency: ${CONCURRENCY_SETTING} | On: ${new URL(tab.url).hostname}\nTab ID: ${tab.id} | v2.0</span>`
        saveState();
    });

    document.getElementById('copy-log-btn').addEventListener('click', () => {
        const text = [...logEl.querySelectorAll('span')].map(s => s.textContent).join('\n');
        navigator.clipboard.writeText(text).then(() => {
            btn.textContent = '✔ Copied!';
            setTimeout(() => btn.textContent = '⎘ Copy Log', 2000);
        });
    });

    // ── Format buttons ────────────────────────────────────────────────────────
    dlFormat = defaultFormat;

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

    // ── Download ──────────────────────────────────────────────────────────────
    startBtn.addEventListener('click', async () => {
        const CONCURRENCY = CONCURRENCY_SETTING;
        const raw = document.getElementById('links').value.trim();
        const links = raw.split('\n').map(l => l.trim()).filter(Boolean);
        if (!links.length) { log('⚠ No links!', 'err'); return; }

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
                await saveHistory({
                    filename: fileHandle.name,
                    infoFile: `${formatBytes(totalBytes)} | ${dlFormat.toUpperCase()} | ${links.length} segs`,
                    siteUrl: tab.url,
                    timestamp: new Date().toISOString()
                });
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
                await saveHistory({
                    filename: fileHandle.name,
                    infoFile: `${formatBytes(outData.byteLength ?? outData.length)} | ${dlFormat.toUpperCase()} | ${links.length} segs`,
                    siteUrl: tab.url,
                    timestamp: new Date().toISOString()
                });
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
                if (type === 'stderr' && message?.trim() && shouldLogFfmpeg(message)) log(message.trim(), 'inf');
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
                if (type === 'stderr' && message?.trim() && shouldLogFfmpeg(message)) log(message.trim(), 'err');
            });
            resetUI();
        }
    });

    // ── Cancel Download ────────────────────────────────────────────
    cancelBtn.addEventListener('click', () => {
        if (!_cancelled) { _cancelled = true; log('⚠ Cancelled', 'err'); resetUI(); }
    });

})();