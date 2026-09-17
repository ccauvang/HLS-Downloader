import { state } from '../state.js';
import { log } from './logger.js';

// popup can't fetch page URLs directly (no cookies/session/CORS context of the page) —
// these proxy the fetch through content.js running in the page itself, correlated by
// a random request id since chrome.tabs.sendMessage has no built-in request/response pairing

export function fetchViaPage(url, frameId = 0, timeoutMs = 30000) {
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
        chrome.tabs.sendMessage(state.tab.id, { type: 'PROXY_FETCH', url, id }, { frameId }, () => {
            if (chrome.runtime.lastError) return; // tab/frame gone — timeout above handles it
        });
    });
}

export function fetchSegmentViaPage(url, frameId = 0, timeoutMs = 60000, retries = 3) {
    return new Promise((resolve, reject) => {
        const attempt = (n) => {
            const id = Math.random().toString(36).slice(2);
            const timer = setTimeout(() => {
                chrome.runtime.onMessage.removeListener(handler);
                if (n > 1) {
                    log(`⚠ Retry seg… (${retries - n + 1})`, 'err');
                    attempt(n - 1);
                }
                else reject(new Error(`Segment fetch timeout: ${url}`));
            }, timeoutMs);
            const handler = async (msg) => {
                if (msg.type !== 'FETCH_SEGMENT_RESPONSE' || msg.id !== id) return;
                clearTimeout(timer);
                chrome.runtime.onMessage.removeListener(handler);
                if (msg.error) {
                    if (msg.status === 429) {
                        // scale backoff by retry attempt so repeated 429s widen the gap instead of hammering identically
                        log(`⚠ Rate limited (429), backing off… ${url}`, 'err');
                        await new Promise(r => setTimeout(r, 5000 * (retries - n + 1)));
                    }
                    if (n > 1) {
                        log(`⚠ Retry seg… (${retries - n + 1})`, 'err');
                        attempt(n - 1);
                    }
                    else reject(new Error(msg.error));
                } else {
                    // segment bytes cross the postMessage/runtime-message boundary as base64 (content.js's
                    // bufToB64) since raw ArrayBuffers can't ride along structured-clone messaging cleanly here
                    const bin = atob(msg.b64);
                    const arr = new Uint8Array(bin.length);
                    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
                    resolve(arr.buffer);
                }
            };
            chrome.runtime.onMessage.addListener(handler);
            chrome.tabs.sendMessage(state.tab.id, { type: 'PROXY_SEGMENT', url, id }, { frameId }, () => {
                if (chrome.runtime.lastError) return;
            });
        };
        attempt(retries);
    });
}

export async function fetchKey(keyUri, baseUrl) {
    const url = keyUri.startsWith('http') ? keyUri : new URL(keyUri, baseUrl).href;
    // key must already be sitting in background.js's keyCache — hook.js (MAIN world) captures it
    // passively off the page's own request, we never re-fetch it ourselves (could 403/expire on retry)
    const bytes = await chrome.runtime.sendMessage({ type: 'GET_CACHED_KEY', url });
    if (!bytes) throw new Error('Key not cached — reload page and retry before key expires');
    return new Uint8Array(bytes).buffer;
}

export async function decryptSegment(buf, keyBuf, iv) {
    const key = await crypto.subtle.importKey('raw', keyBuf, 'AES-CBC', false, ['decrypt']);
    return await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, buf);
}