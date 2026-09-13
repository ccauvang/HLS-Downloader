import { dom } from './dom.js';
import { state, saveState } from './state.js';
import { log } from './utils/logger.js';
import { detectStreamInfo } from './utils/m3u8.js';
import { updateDropdown, wireDropdown } from './ui/dropdown.js';
import { preloadViews, wireViewButtons } from './ui/views.js';
import { resetUI } from './ui/progress.js';
import { createFfmpeg, loadFFmpeg } from './ffmpeg/engine.js';
import { parseStream } from './download/parse.js';
import { runDownload } from './download/downloader.js';

(async function () {
    'use strict';

    createFfmpeg('inf');
    loadFFmpeg().catch(e => console.error('ffmpeg preload fail:', e));

    // ── Preload history & settings assets ────────────────────────────────────
    preloadViews();

    // ── Load detected URLs from background ────────────────────────────────────
    const params = new URLSearchParams(window.location.search);
    state.tab = await chrome.tabs.get(parseInt(params.get('tabId')));
    state.STATE_KEY = `state_${state.tab.id}`;
    state.detectedM3u8 = await chrome.runtime.sendMessage({ type: 'GET_URLS', tabId: state.tab.id }) || [];

    (async () => {
        for (let i = 0; i < state.detectedM3u8.length; i++) {
            if (typeof state.detectedM3u8[i] !== 'string') continue;
            const info = await detectStreamInfo(state.detectedM3u8[i]).catch(() => null);
            if (info) state.detectedM3u8[i] = info;
            updateDropdown();
        }
    })();

    document.getElementById('links').addEventListener('input', saveState);
    document.getElementById('filename').addEventListener('input', saveState);

    chrome.runtime.sendMessage({ type: 'SET_ACTIVE_TAB', tabId: state.tab.id });
    window.addEventListener('unload', () => {
        chrome.runtime.sendMessage({ type: 'UNSET_ACTIVE_TAB', tabId: state.tab.id });
    });

    const { filename: defaultFilename, concurrency: CONCURRENCY_SETTING, format: defaultFormat } = await new Promise(r =>
        chrome.storage.sync.get({ filename: 'video', concurrency: 5, format: 'mp4' }, r)
    );
    state.CONCURRENCY_SETTING = CONCURRENCY_SETTING;
    state.defaultFilename = defaultFilename;

    document.getElementById('first-log').textContent =
        `Ready. Concurrency: ${state.CONCURRENCY_SETTING} | On: ${new URL(state.tab.url).hostname}\nTab ID: ${state.tab.id} | v2.0`;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'SETTINGS_UPDATED') return;
        const { concurrency, format } = msg.changes;
        if (concurrency) state.CONCURRENCY_SETTING = concurrency.newValue;
        if (format) {
            state.dlFormat = format.newValue;
            dom.btnMp4.className = state.dlFormat === 'mp4' ? 'fmt-active' : 'fmt-inactive';
            dom.btnTs.className = state.dlFormat === 'ts' ? 'fmt-active' : 'fmt-inactive';
        }

        document.getElementById('first-log').textContent =
            `Ready. Concurrency: ${state.CONCURRENCY_SETTING} | On: ${new URL(state.tab.url).hostname}\nTab ID: ${state.tab.id} | v2.0`;
    });

    updateDropdown();

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'HLS_DETECTED') return;
        if (msg.tabId !== state.tab.id) return;
        if (state.detectedM3u8.find(e => (typeof e === 'object' ? e.url : e) === msg.url)) return;
        // verify via page context before showing
        detectStreamInfo(msg.url).then(info => {
            if (!info) return;
            if (!state.detectedM3u8.find(e => (typeof e === 'object' ? e.url : e) === info.url)) {
                state.detectedM3u8.push(info);
                updateDropdown();
            }
        }).catch(() => {
            // verify failed (likely content script not ready right after reload) — add unverified, user can still pick it, gets enriched next popup open
            if (!state.detectedM3u8.find(e => (typeof e === 'object' ? e.url : e) === msg.url)) {
                state.detectedM3u8.push(msg.url);
                updateDropdown();
            }
        });
    });
    
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (tabId !== state.tab.id) return;
    if (changeInfo.status === 'loading') {
        state.detectedM3u8.length = 0;
        updateDropdown();
    }
});


    chrome.storage.session.get(state.STATE_KEY, (s) => {
        const saved = s[state.STATE_KEY];
        if (!saved) {
            document.getElementById('filename').value = state.defaultFilename;
            return;
        }
        if (saved.links) document.getElementById('links').value = saved.links;
        if (saved.filename) document.getElementById('filename').value = saved.filename;
        if (saved.m3u8Url) document.getElementById('m3u8-url').value = saved.m3u8Url;
        if (saved.logHtml) dom.logEl.innerHTML = saved.logHtml;
        if (saved.dlFormat) {
            state.dlFormat = saved.dlFormat;
            dom.btnMp4.className = state.dlFormat === 'mp4' ? 'fmt-active' : 'fmt-inactive';
            dom.btnTs.className = state.dlFormat === 'ts' ? 'fmt-active' : 'fmt-inactive';
        }

        if (saved.detectedM3u8?.length) {
            saved.detectedM3u8.forEach(e => {
                const url = typeof e === 'string' ? e : e.url;
                const idx = state.detectedM3u8.findIndex(x => (typeof x === 'string' ? x : x.url) === url);
                if (idx === -1) state.detectedM3u8.push(e);
                else if (typeof e === 'object' && typeof state.detectedM3u8[idx] === 'string') state.detectedM3u8[idx] = e; // upgrade string → rich
            });
            updateDropdown();
        }
    });

    // ── View switching ────────────────────────────────────────────────────────
    wireViewButtons();

    // ── Dropdown and Reload ──────────────────────────────────────────────────
    wireDropdown();

    document.getElementById('reload-btn').addEventListener('click', () => {
        chrome.tabs.reload(state.tab.id);
        state.detectedM3u8.length = 0;
        updateDropdown();
    });

    // ── Parse ─────────────────────────────────────────────────────────────────
    document.getElementById('parse-btn').addEventListener('click', () => {
        const url = document.getElementById('m3u8-url').value.trim();
        if (!url) { log('⚠ No m3u8 URL!', 'err'); return; }
        parseStream(url);
    });

    // ── Log buttons ───────────────────────────────────────────────────────────
    document.getElementById('clear-log-btn').addEventListener('click', () => {
        dom.logEl.innerHTML = `<span class="inf">Ready. Concurrency: ${state.CONCURRENCY_SETTING} | On: ${new URL(state.tab.url).hostname}\nTab ID: ${state.tab.id} | v2.0</span>`
        saveState();
    });

    document.getElementById('copy-log-btn').addEventListener('click', () => {
        const text = [...dom.logEl.querySelectorAll('span')].map(s => s.textContent).join('\n');
        const btn = document.getElementById('copy-log-btn');
        navigator.clipboard.writeText(text).then(() => {
            btn.textContent = '✔ Copied!';
            setTimeout(() => btn.textContent = '⎘ Copy Log', 2000);
        });
    });

    // ── Format buttons ────────────────────────────────────────────────────────
    state.dlFormat = defaultFormat;

    // set initial style from settings
    dom.btnMp4.className = state.dlFormat === 'mp4' ? 'fmt-active' : 'fmt-inactive';
    dom.btnTs.className = state.dlFormat === 'ts' ? 'fmt-active' : 'fmt-inactive';

    dom.btnMp4.addEventListener('click', () => {
        state.dlFormat = 'mp4';
        dom.btnMp4.className = 'fmt-active';
        dom.btnTs.className = 'fmt-inactive';
        saveState();
    });
    dom.btnTs.addEventListener('click', () => {
        state.dlFormat = 'ts';
        dom.btnTs.className = 'fmt-active';
        dom.btnMp4.className = 'fmt-inactive';
        saveState();
    });

    // ── Download ──────────────────────────────────────────────────────────────
    dom.startBtn.addEventListener('click', runDownload);

    // ── Cancel Download ────────────────────────────────────────────
    dom.cancelBtn.addEventListener('click', () => {
        if (!state.cancelled) { state.cancelled = true; log('⚠ Cancelled', 'err'); resetUI(); }
    });

})();