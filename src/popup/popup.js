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
    loadFFmpeg().catch(e => console.error('ffmpeg preload fail:', e)); // non-fatal — actual download flow re-awaits loadFFmpeg() before use

    // ── Preload history & settings assets ────────────────────────────────────
    preloadViews();

    // ── Load detected URLs from background ────────────────────────────────────
    const params = new URLSearchParams(window.location.search);
    state.tab = await chrome.tabs.get(parseInt(params.get('tabId')));
    state.STATE_KEY = `state_${state.tab.id}`;
    const siteHost = new URL(state.tab.url).hostname;

    document.getElementById('site-url-label').textContent = siteHost;

    const blBtn = document.getElementById('blacklist-btn');
    chrome.runtime.sendMessage({ type: 'GET_BLACKLIST_STATUS', tabId: state.tab.id }, (res) => {
        if (res?.blacklisted) {
            blBtn.classList.add('active');
            blBtn.textContent = 'Resume detection';
        }
    });

    blBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_BLACKLIST', host: siteHost }, (res) => {
            blBtn.classList.toggle('active', res.blacklisted);
            blBtn.textContent = res.blacklisted ? 'Resume detection' : 'Pause detection here';
        });
    });

    state.detectedM3u8 = (await chrome.runtime.sendMessage({ type: 'GET_URLS', tabId: state.tab.id })) || [];

    // background only stores bare {url, frameId} — enrich each with segment count/duration
    // in the background so the dropdown doesn't block on it; updateDropdown() repaints as each resolves
    (async () => {
        for (let i = 0; i < state.detectedM3u8.length; i++) {
            const entry = state.detectedM3u8[i];
            if (typeof entry !== 'object' || entry.isMaster !== undefined) continue; // already rich or malformed
            const info = await detectStreamInfo(entry.url, entry.frameId).catch(() => null);
            if (info) state.detectedM3u8[i] = { ...info, frameId: entry.frameId };
            updateDropdown();
        }
    })();

    document.getElementById('links').addEventListener('input', saveState);
    document.getElementById('filename').addEventListener('input', saveState);

    // background only pushes live HLS_DETECTED updates to tabs it knows have a popup open —
    // this pair marks the window so background.js's activePopupTabs check includes us
    chrome.runtime.sendMessage({ type: 'SET_ACTIVE_TAB', tabId: state.tab.id });
    window.addEventListener('unload', () => {
        chrome.runtime.sendMessage({ type: 'UNSET_ACTIVE_TAB', tabId: state.tab.id });
    });

    const { filename: defaultFilename, concurrency: CONCURRENCY_SETTING, format: defaultFormat, chunkDelay, chunkDelayEnabled } = await new Promise(r =>
        chrome.storage.sync.get({ filename: 'video', concurrency: 5, format: 'mp4', chunkDelay: 300, chunkDelayEnabled: true }, r)
    );
    state.CONCURRENCY_SETTING = CONCURRENCY_SETTING;
    state.defaultFilename = defaultFilename;
    state.chunkDelay = chunkDelay;
    state.chunkDelayEnabled = chunkDelayEnabled;

    // first-log line can be missing if the user cleared the log without the id-preserving
    // fix (or on some other DOM edge case) — guard so this doesn't throw and kill the listener
    const firstLogEl = document.getElementById('first-log');
    if (firstLogEl) firstLogEl.textContent =
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
        if (msg.changes.chunkDelay) state.chunkDelay = msg.changes.chunkDelay.newValue;
        if (msg.changes.chunkDelayEnabled) state.chunkDelayEnabled = msg.changes.chunkDelayEnabled.newValue;

        const firstLogEl = document.getElementById('first-log');
        if (firstLogEl) firstLogEl.textContent =
            `Ready. Concurrency: ${state.CONCURRENCY_SETTING} | On: ${new URL(state.tab.url).hostname}\nTab ID: ${state.tab.id} | v2.0`;
    });

    updateDropdown();

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'HLS_DETECTED') return;
        if (msg.tabId !== state.tab.id) return;
        if (state.detectedM3u8.find(e => e.url === msg.url)) return;
        detectStreamInfo(msg.url, msg.frameId).then(info => {
            if (!info) return;
            if (!state.detectedM3u8.find(e => e.url === info.url)) {
                state.detectedM3u8.push({ ...info, frameId: msg.frameId });
                updateDropdown();
            }
        }).catch(() => {
            // detectStreamInfo failed (fetch error, malformed playlist, etc) — still record
            // the bare url so it's selectable, just without the rich label
            state.detectedM3u8.push({ url: msg.url, frameId: msg.frameId });
            updateDropdown();
        });
    });

    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
        if (tabId !== state.tab.id) return;
        if (changeInfo.status === 'loading') {
            // page navigated — old detected streams belong to a page that's gone now
            state.detectedM3u8.length = 0;
            updateDropdown();
        }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
        if (tabId === state.tab.id) window.close(); // popup is tied to this tab, no reason to keep it open
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
        // id="first-log" must survive this rebuild — SETTINGS_UPDATED and the initial paint
        // both target that id directly, and losing it here is what caused the earlier crash
        dom.logEl.innerHTML = `<span id="first-log" class="inf">Ready. Concurrency: ${state.CONCURRENCY_SETTING} | On: ${new URL(state.tab.url).hostname}\nTab ID: ${state.tab.id} | v2.0</span>`
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