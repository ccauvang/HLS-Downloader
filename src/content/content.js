(function () {
    'use strict';

    // used by PROXY_FETCH / PROXY_SEGMENT / CONFIRM_HLS_CANDIDATE below.
    // this is the isolated world: overriding window.fetch/XHR here would NOT touch the page's own calls
    // (that needs MAIN world, see hook.js) — detection comes from background.js webRequest instead
    const _origFetch = window.fetch.bind(window);

    function safeSend(msg) {
        // content script context can be torn down mid-navigation — swallow the "context invalidated" throw
        try { chrome.runtime.sendMessage(msg); } catch (e) { }
    }

    // <video src> can be a plain mp4/webm. background counts every HLS_DETECTED toward the badge and the popup
    // lists it too, so non-HLS media must be filtered here, at the source
    const NON_HLS_SRC = /\.(mp4|webm|m4s|m4v|mkv|mov|ts|aac|mp3|ogg)(\?|#|$)/i;
    function sendVideoSrc(src) {
        if (src && src.startsWith('http') && !NON_HLS_SRC.test(src)) safeSend({ type: 'HLS_DETECTED', url: src });
    }

    function scanVideoTags() {
        // catches streams already sitting in the DOM on load (no network hook would fire for these)
        document.querySelectorAll('video, source').forEach(el => sendVideoSrc(el.src || el.getAttribute('src') || ''));
    }

    function bufToB64(buf) {
        // chunked to avoid call-stack blowup from String.fromCharCode.apply on large segment buffers
        let bin = '';
        const bytes = new Uint8Array(buf);
        for (let i = 0; i < bytes.length; i += 0x8000)
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(bin);
    }

    // relay from hook.js (MAIN world) — isolated world content scripts can't see MAIN world's
    // fetch/XHR overrides directly, so key bytes cross over via postMessage instead
    window.addEventListener('message', (event) => {
        if (event.source !== window || event.data?.type !== 'HLS_KEY_CAPTURED') return;
        chrome.runtime.sendMessage({ type: 'HLS_KEY_CACHE_SET', url: event.data.url, bytes: event.data.bytes });
    });

    // popup.js can't fetch page URLs directly (CORS/session/cookie context lives on the page,
    // not the extension) — so it asks this content script to fetch on its behalf via background relay
    window.addEventListener('message', async (event) => {
        if (event.source !== window || event.data?.type !== 'FETCH_M3U8_REQUEST') return;
        try {
            const res = await _origFetch(event.data.url);
            const text = await res.text();
            safeSend({ type: 'FETCH_M3U8_RESPONSE', id: event.data.id, text });
        } catch (e) {
            safeSend({ type: 'FETCH_M3U8_RESPONSE', id: event.data.id, error: e.message });
        }
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'PROXY_FETCH') return;
        window.postMessage({ type: 'FETCH_M3U8_REQUEST', url: msg.url, id: msg.id }, '*');
    });

    // same proxy pattern as above, but for binary segment bytes (base64-encoded to survive
    // the postMessage/runtime-message JSON boundary)
    window.addEventListener('message', async (event) => {
        if (event.source !== window || event.data?.type !== 'FETCH_SEGMENT_REQUEST') return;
        try {
            const res = await _origFetch(event.data.url);
            if (!res.ok) {
                safeSend({ type: 'FETCH_SEGMENT_RESPONSE', id: event.data.id, error: `HTTP ${res.status}`, status: res.status });
                return;
            }
            const buf = await res.arrayBuffer();
            safeSend({ type: 'FETCH_SEGMENT_RESPONSE', id: event.data.id, b64: bufToB64(buf) });
        } catch (e) {
            safeSend({ type: 'FETCH_SEGMENT_RESPONSE', id: event.data.id, error: e.message });
        }
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'PROXY_SEGMENT') return;
        window.postMessage({ type: 'FETCH_SEGMENT_REQUEST', url: msg.url, id: msg.id }, '*');
    });

    // background.js asks for a body-sniff confirm on "hls-maybe" tier candidates (ambiguous
    // content-type/path hints) before promoting them to a real detected stream
    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'CONFIRM_HLS_CANDIDATE') return;
        _origFetch(msg.url).then(res => res.text()).then(text => {
            if (text.trimStart().startsWith('#EXTM3U')) {
                safeSend({ type: 'HLS_DETECTED', url: msg.url });
            }
        }).catch(() => { });
    });

    // catches video/source tags that get added dynamically after initial load (SPA players,
    // lazy-mounted players, ad-gated content, etc) — scanVideoTags() alone only covers page-load state
    const _observer = new MutationObserver((mutations) => {
        for (const mut of mutations) {
            for (const node of mut.addedNodes) {
                if (node.nodeType !== 1) continue;
                const tag = node.tagName?.toLowerCase();
                if (tag === 'video' || tag === 'source') sendVideoSrc(node.src || node.getAttribute('src') || '');
                // check children
                node.querySelectorAll?.('video, source').forEach(el => sendVideoSrc(el.src || el.getAttribute('src') || ''));
            }
        }
    });

    _observer.observe(document.documentElement, { childList: true, subtree: true });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', scanVideoTags);
    } else {
        scanVideoTags();
    }
})();