import { dom } from './dom.js';
import { state, saveState, pageKey } from './state.js';
import { log } from './utils/logger.js';
import { detectStreamInfo } from './utils/m3u8.js';
import { updateDropdown, wireDropdown } from './ui/dropdown.js';
import { preloadViews, wireViewButtons } from './ui/views.js';
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
    const blBtn = document.getElementById('blacklist-btn');
    let siteHost = '';
    let curPage = pageKey(state.tab.url); // onUpdated below compares against this to tell "moved to another page" from "same page reloaded"

    // host label + blacklist button follow state.tab — runs on open and again whenever the tab navigates.
    // read storage directly with siteHost — background's tabHostnames is empty after extension reload,
    // so asking it by tabId returns false until SET_ACTIVE_TAB backfills
    function syncSite() {
        try { siteHost = new URL(state.tab.url).hostname; } catch (e) { siteHost = ''; }
        document.getElementById('site-url-label').textContent = siteHost;
        chrome.storage.sync.get({ blacklist: [] }, (s) => {
            const on = s.blacklist.includes(siteHost);
            blBtn.classList.toggle('active', on);
            blBtn.textContent = on ? 'Resume detection' : 'Pause detection';
        });
    }
    syncSite();

    blBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'TOGGLE_BLACKLIST', host: siteHost }, (res) => {
            blBtn.classList.toggle('active', res.blacklisted);
            blBtn.textContent = res.blacklisted ? 'Resume detection' : 'Pause detection';
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
            // list may have been cleared (reload) or the slot replaced while we awaited — writing by index
            // then leaves holes, and `.length` (the "Detected streams (N)" count) counts the holes
            if (info && state.detectedM3u8[i] === entry) state.detectedM3u8[i] = { ...info, frameId: entry.frameId };
            updateDropdown();
        }
    })();

    document.getElementById('links').addEventListener('input', saveState);
    document.getElementById('filename').addEventListener('input', saveState);

    // blank on blur → put settings default back (blur not input, else can't clear field to retype)
    document.getElementById('filename').addEventListener('blur', (e) => {
        if (!e.target.value.trim()) {
            e.target.value = state.defaultFilename;
            saveState();
        }
    });

    // background only pushes live HLS_DETECTED updates to tabs it knows have a popup open —
    // this pair marks the window so background.js's activePopupTabs check includes us
    chrome.runtime.sendMessage({ type: 'SET_ACTIVE_TAB', tabId: state.tab.id });
    window.addEventListener('unload', () => {
        chrome.runtime.sendMessage({ type: 'UNSET_ACTIVE_TAB', tabId: state.tab.id });
    });

    const { filename: defaultFilename, concurrency: CONCURRENCY_SETTING, format: defaultFormat, chunkDelay, chunkDelayEnabled } = await new Promise(r =>
        chrome.storage.sync.get({ filename: 'video', concurrency: 5, format: 'mp4', chunkDelay: 300, chunkDelayEnabled: true }, r)
    );
    state.CONCURRENCY_SETTING = Math.min(9, Math.max(3, parseInt(CONCURRENCY_SETTING, 10) || 5));
    state.defaultFilename = defaultFilename;
    state.chunkDelay = Math.min(10000, Math.max(0, parseInt(chunkDelay, 10) || 0));
    state.chunkDelayEnabled = chunkDelayEnabled;

    // first-log line can be missing if the user cleared the log without the id-preserving
    // fix (or on some other DOM edge case) — guard so this doesn't throw and kill the listener
    const firstLogEl = document.getElementById('first-log');
    if (firstLogEl) firstLogEl.textContent =
        `Ready. Concurrency: ${state.CONCURRENCY_SETTING} | On: ${new URL(state.tab.url).hostname}\nTab ID: ${state.tab.id} | v2.0`;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'SETTINGS_UPDATED') return;
        const { concurrency, format } = msg.changes;
        if (concurrency) state.CONCURRENCY_SETTING = Math.min(9, Math.max(3, parseInt(concurrency.newValue, 10) || 5));
        if (format && !dom.startBtn.disabled) {
            state.dlFormat = format.newValue === 'ts' ? 'ts' : 'mp4';
            dom.btnMp4.className = state.dlFormat === 'mp4' ? 'fmt-active' : 'fmt-inactive';
            dom.btnTs.className = state.dlFormat === 'ts' ? 'fmt-active' : 'fmt-inactive';
        }
        if (msg.changes.chunkDelay) state.chunkDelay = Math.min(10000, Math.max(0, parseInt(msg.changes.chunkDelay.newValue, 10) || 0));
        if (msg.changes.chunkDelayEnabled) state.chunkDelayEnabled = msg.changes.chunkDelayEnabled.newValue;
        if (msg.changes.filename) state.defaultFilename = msg.changes.filename.newValue;

        const firstLogEl = document.getElementById('first-log');
        if (firstLogEl) firstLogEl.textContent =
            `Ready. Concurrency: ${state.CONCURRENCY_SETTING} | On: ${new URL(state.tab.url).hostname}\nTab ID: ${state.tab.id} | v2.0`;
    });

    updateDropdown();

    // bumped on every page load — lets late async results know their page is gone
    let loadGen = 0;

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'HLS_DETECTED') return;
        if (msg.tabId !== state.tab.id) return;
        if (state.detectedM3u8.find(e => e.url === msg.url)) return;
        const gen = loadGen;
        detectStreamInfo(msg.url, msg.frameId).catch(() => null).then(info => {
            if (gen !== loadGen) return; // page reloaded while this was pending — don't push the old page's stream
            if (state.detectedM3u8.find(e => e.url === msg.url)) return;
            // null = fetch failed or body isn't #EXTM3U. still push the bare url: background already counted it
            // toward the badge, so dropping it here is what made badge and list disagree
            state.detectedM3u8.push(info ? { ...info, frameId: msg.frameId } : { url: msg.url, frameId: msg.frameId });
            updateDropdown();
        });
    });

    // holds the old page's stream — cleared only on a real page change, not a plain reload
    function clearStreamFields() {
        document.getElementById('m3u8-url').value = '';
        document.getElementById('links').value = '';
        state.currentFrameId = 0;
        window._hlsKey = null; window._hlsIv = null; window._hlsHasKey = false;
        window._hlsInitUrl = null; window._hlsAudioInitUrl = null; window._hlsAudioSegments = null;
    }

    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (tabId !== state.tab.id) return;
        // state.tab is a snapshot from popup open — refresh it, or history siteUrl / saveState / log
        // keep reporting the page the tab used to be on
        if (changeInfo.url || changeInfo.status) state.tab = tab;
        if (changeInfo.status === 'loading') {
            loadGen++;
            // page navigated — old detected streams belong to a page that's gone now
            state.detectedM3u8.length = 0;
            updateDropdown();
        }
        // status only (loading/complete), so a player rewriting the url (?t=30) isn't treated as a new page
        if (changeInfo.status && pageKey(state.tab.url) !== curPage) {
            curPage = pageKey(state.tab.url);
            syncSite();
            // mid-download the run reads these live — leave them alone
            if (!dom.startBtn.disabled) { clearStreamFields(); saveState(); }
        }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
        if (tabId === state.tab.id) window.close(); // popup is tied to this tab, no reason to keep it open
    });

    chrome.storage.session.get(state.STATE_KEY, (s) => {
        const saved = s[state.STATE_KEY];
        // saved state is keyed by tabId only — if the tab moved to another page while the popup was closed,
        // restoring would bring back the old page's m3u8 / links / dropdown entries
        if (!saved || saved.pageUrl !== pageKey(state.tab.url)) {
            if (saved) chrome.storage.session.remove(state.STATE_KEY);
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
            // background's list is the truth — saved entries may only upgrade ones it still has (keeps cachedText
            // for tokenized playlists), never add. pushing here is how streams from before a reload came back
            saved.detectedM3u8.forEach(e => {
                if (typeof e !== 'object' || e.isMaster === undefined) return; // only rich entries are worth restoring
                const idx = state.detectedM3u8.findIndex(x => x.url === e.url);
                if (idx !== -1 && state.detectedM3u8[idx].isMaster === undefined)
                    state.detectedM3u8[idx] = { ...e, frameId: state.detectedM3u8[idx].frameId };
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
        if (state.cancelled) return;
        state.cancelled = true;
        dom.cancelBtn.disabled = true;
        // no resetUI() here on purpose — Start stays locked until runDownload winds down on its own.
        // unlocking now lets a new run reset state.cancelled while old workers are still draining
        log('⚠ Cancelling… waiting for in-flight segments', 'err');
    });

})();