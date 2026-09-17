import { state } from '../state.js';
import { log } from '../utils/logger.js';
import { fetchSegmentViaPage, decryptSegment } from '../utils/bridge.js';
import { setProgress } from '../ui/progress.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

function computeIv(i) {
    return window._hlsIv?.byteLength
        ? window._hlsIv
        : (() => { const b = new Uint8Array(16); new DataView(b.buffer).setUint32(12, i + 1); return b; })();
}

async function decryptIfNeeded(buf, i) {
    if (window._hlsHasKey && window._hlsKey) {
        return await decryptSegment(buf, window._hlsKey, computeIv(i));
    }
    return buf;
}

export async function downloadVideoSegments(links, segExt, CONCURRENCY, dlStart) {
    const segNames = [];
    let done = 0;
    const vQueue = links.map((url, i) => async () => {
        if (state.cancelled) return;
        let buf = await fetchSegmentViaPage(url, state.currentFrameId);
        buf = await decryptIfNeeded(buf, i);
        const name = `seg${String(i).padStart(6, '0')}${segExt}`;
        const segSize = buf.byteLength;
        await state.ffmpeg.writeFile(name, new Uint8Array(buf));
        segNames[i] = name;
        state.bytesDownloaded += segSize;
        setProgress(++done, links.length, dlStart, state.bytesDownloaded);
        if (done % CONCURRENCY === 0 || done === links.length) {
            log(`✔ segs ${done - (done % CONCURRENCY || CONCURRENCY) + 1}–${done}/${links.length}`, 'ok');
        }
        if (state.chunkDelayEnabled && state.chunkDelay > 0 && vQueue.length > 0) await sleep(state.chunkDelay);
    });
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (vQueue.length) await vQueue.shift()(); }));
    log(`✔ ${links.length} segs done`, 'ok');
    return segNames;
}

export async function downloadAudioSegments(audioUrls, segExt, CONCURRENCY, dlStart, writeFileSerial) {
    const audioSegNames = [];
    if (!audioUrls?.length) return audioSegNames;
    log(`Downloading ${audioUrls.length} audio segs…`, 'inf');
    const names = [];
    let aDone = 0;
    const aQueue = audioUrls.map((url, i) => async () => {
        if (state.cancelled) return;
        const buf = new Uint8Array(await fetchSegmentViaPage(url, state.currentFrameId));
        const name = `aseg${String(i).padStart(6, '0')}${segExt}`;
        const segSize = buf.byteLength;
        await writeFileSerial(name, buf);
        names[i] = name;
        state.bytesDownloaded += segSize;
        setProgress(++aDone, audioUrls.length, dlStart, state.bytesDownloaded);
        if (aDone % CONCURRENCY === 0 || aDone === audioUrls.length) {
            log(`✔ audio segs ${aDone - (aDone % CONCURRENCY || CONCURRENCY) + 1}–${aDone}/${audioUrls.length}`, 'ok');
        }
        if (state.chunkDelayEnabled && state.chunkDelay > 0 && aQueue.length > 0) await sleep(state.chunkDelay);
    });
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (aQueue.length) await aQueue.shift()(); }));
    audioSegNames.push(...names.filter(Boolean));
    return audioSegNames;
}

// rare ffmpeg.wasm write race under concurrency — re-check every segment landed, refetch any that didn't
export async function verifySegments(segNames, links, writeFileSerial) {
    log('Verifying segments…', 'inf');
    for (let i = 0; i < segNames.length; i++) {
        const name = segNames[i];
        if (!name) continue;
        let ok = false;
        try {
            const data = await state.ffmpeg.readFile(name);
            ok = data && (data.byteLength ?? data.length) > 0;
        } catch (e) { ok = false; }
        if (!ok) {
            log(`⚠ Bad segment ${name}, refetching…`, 'err');
            let buf = await fetchSegmentViaPage(links[i], state.currentFrameId);
            buf = await decryptIfNeeded(buf, i);
            await writeFileSerial(name, new Uint8Array(buf));
        }
    }
}
