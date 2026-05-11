(function () {
    'use strict';

    const _origFetch = window.fetch.bind(window);

    function safeSend(msg) {
        try { chrome.runtime.sendMessage(msg); } catch (e) { }
    }

    function scanVideoTags() {
        document.querySelectorAll('video, source').forEach(el => {
            const src = el.src || el.getAttribute('src') || '';
            if (src && src.startsWith('http')) {
                safeSend({ type: 'HLS_DETECTED', url: src });
            }
        });
    }

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
        this._url = url;
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
    window.addEventListener('message', async (event) => {
        if (event.source !== window || event.data?.type !== 'FETCH_SEGMENT_REQUEST') return;
        try {
            const res = await _origFetch(event.data.url);
            const buf = await res.arrayBuffer();
            const arr = Array.from(new Uint8Array(buf));
            safeSend({ type: 'FETCH_SEGMENT_RESPONSE', id: event.data.id, arr });
        } catch (e) {
            safeSend({ type: 'FETCH_SEGMENT_RESPONSE', id: event.data.id, error: e.message });
        }
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (msg.type !== 'PROXY_SEGMENT') return;
        window.postMessage({ type: 'FETCH_SEGMENT_REQUEST', url: msg.url, id: msg.id }, '*');
    });

    const _observer = new MutationObserver((mutations) => {
        for (const mut of mutations) {
            for (const node of mut.addedNodes) {
                if (node.nodeType !== 1) continue;
                const src = node.src || node.getAttribute?.('src') || '';
                if (src && src.startsWith('http')) safeSend({ type: 'HLS_DETECTED', url: src });
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