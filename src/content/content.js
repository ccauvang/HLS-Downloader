(function () {
    'use strict';

    // grab the real fetch before hook.js/page scripts get a chance to wrap it further —
    // this is what PROXY_FETCH/PROXY_SEGMENT use to bypass our own override below
    const _origFetch = window.fetch.bind(window);

    function safeSend(msg) {
        // content script context can be torn down mid-navigation — swallow the "context invalidated" throw
        try { chrome.runtime.sendMessage(msg); } catch (e) { }
    }

    function scanVideoTags() {
        // catches streams already sitting in the DOM on load (no network hook would fire for these)
        document.querySelectorAll('video, source').forEach(el => {
            const src = el.src || el.getAttribute('src') || '';
            if (src && src.startsWith('http')) {
                safeSend({ type: 'HLS_DETECTED', url: src });
            }
        });
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

    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
        if (url.includes('.m3u8')) {
            safeSend({ type: 'HLS_DETECTED', url });
            return _origFetch(...args);
        }
        const res = await _origFetch(...args);
        try {
            const ct = res.headers.get('content-type') || '';
            if (ct.includes('mpegurl') || ct.includes('apple.mpegurl')) {
                safeSend({ type: 'HLS_DETECTED', url });
                return res;
            }
            // some servers mislabel content-type — fall back to sniffing the actual playlist header.
            // res.clone() needed since body streams can only be read once and the caller still needs it.
            const clone = res.clone();
            const text = await clone.text();
            if (text.trimStart().startsWith('#EXTM3U')) {
                safeSend({ type: 'HLS_DETECTED', url });
            }
        } catch (e) { }
        return res;
    };

    const _origOpen = XMLHttpRequest.prototype.open;
    const _origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._url = url; // stash for .send() to read, since url isn't otherwise available there
        return _origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...args) {
        if (this._url) {
            if (this._url.includes('.m3u8')) {
                safeSend({ type: 'HLS_DETECTED', url: this._url });
            } else {
                this.addEventListener('load', function () {
                    try {
                        const ct = this.getResponseHeader('content-type') || '';
                        if (ct.includes('mpegurl') || ct.includes('apple.mpegurl')) {
                            safeSend({ type: 'HLS_DETECTED', url: this._url });
                            return;
                        }
                        // same mislabeled-content-type fallback as the fetch hook above
                        const text = typeof this.responseText === 'string' ? this.responseText : '';
                        if (text.trimStart().startsWith('#EXTM3U')) {
                            safeSend({ type: 'HLS_DETECTED', url: this._url });
                        }
                    } catch (e) { }
                });
            }
        }
        return _origSend.call(this, ...args);
    };

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
                if (tag === 'video' || tag === 'source') {
                    const src = node.src || node.getAttribute('src') || '';
                    if (src && src.startsWith('http')) safeSend({ type: 'HLS_DETECTED', url: src });
                }
                // check children
                node.querySelectorAll?.('video, source').forEach(el => {
                    const s = el.src || el.getAttribute('src') || '';
                    if (s && s.startsWith('http')) safeSend({ type: 'HLS_DETECTED', url: s });
                });
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