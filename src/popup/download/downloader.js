import { dom } from '../dom.js';
import { state, saveState } from '../state.js';
import { log } from '../utils/logger.js';
import { fetchSegmentViaPage } from '../utils/bridge.js';
import { formatBytes, formatDuration } from '../utils/format.js';
import { setProgress, resetUI } from '../ui/progress.js';
import { saveHistory } from '../store/history-store.js';
import { loadFFmpeg, resetFfmpeg } from '../ffmpeg/engine.js';
import { downloadVideoSegments, downloadAudioSegments, verifySegments } from './segments.js';
import { mergeFmp4Fragments, writeConcatLists, remux, readAndCleanupOutput } from './mux.js';

export async function runDownload() {
    let _fsWriteChain = Promise.resolve();
    const CONCURRENCY = state.CONCURRENCY_SETTING;
    const raw = document.getElementById('links').value.trim();
    const links = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (!links.length) { log('⚠ No links!', 'err'); return; }

    function writeFileSerial(name, data) {
        _fsWriteChain = _fsWriteChain.then(() => state.ffmpeg.writeFile(name, data));
        return _fsWriteChain;
    }

    const filename = document.getElementById('filename').value.trim() || 'video.mp4';
    dom.startBtn.disabled = true; state.cancelled = false; dom.cancelBtn.disabled = false;
    log('─────────────────────', 'fire');
    dom.barEl.style.width = '0%';
    dom.percentEl.textContent = '0%';
    state.bytesDownloaded = 0;

    try {
        // ── Pick save location ───────────────────────────────────────────
        const ext = state.dlFormat === 'ts' ? '.ts' : '.mp4';
        const baseName = filename.replace(/\.(mp4|ts)$/i, '');
        const fileHandle = await window.showSaveFilePicker({
            suggestedName: baseName + ext,
            types: state.dlFormat === 'ts'
                ? [{ description: 'TS Video', accept: { 'video/mp2t': ['.ts'] } }]
                : [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }]
        });
        const writable = await fileHandle.createWritable();

        // ── Load ffmpeg ──────────────────────────────────────────────────
        await loadFFmpeg();

        // ── Handle fMP4 init segment ─────────────────────────────────────
        if (window._hlsInitUrl) {
            log('fMP4 — fetching init…', 'inf');
            const initBuf = new Uint8Array(await fetchSegmentViaPage(window._hlsInitUrl, state.currentFrameId));
            await state.ffmpeg.writeFile('init.mp4', initBuf);
        }
        if (window._hlsAudioInitUrl) {
            const aInitBuf = new Uint8Array(await fetchSegmentViaPage(window._hlsAudioInitUrl, state.currentFrameId));
            await state.ffmpeg.writeFile('init_a.mp4', aInitBuf);
        }

        const dlStart = performance.now();
        log(`${links.length} segments. Downloading…`, 'fire');

        // ── Download segments → write to ffmpeg FS ───────────────────────
        const segExt = window._hlsInitUrl ? '.mp4' : '.ts';
        const segNames = await downloadVideoSegments(links, segExt, CONCURRENCY, dlStart);

        if (state.cancelled) {
            await writable.abort();
            for (const n of segNames) await state.ffmpeg.deleteFile(n).catch(() => { });
            setProgress(0, links.length); resetUI(); return;
        }

        // ── Download audio segments → ffmpeg FS ─────────────────────────
        const audioSegNames = await downloadAudioSegments(window._hlsAudioSegments, segExt, CONCURRENCY, dlStart, writeFileSerial);

        // ── Download done ────────────────────────────────────
        const dlEnd = performance.now();
        const avgElapsed = (performance.now() - dlStart) / 1000;
        const avgSpeed = state.bytesDownloaded / avgElapsed;

        log(`⏱ Download segments done in: ${formatDuration(Math.ceil((dlEnd - dlStart) / 1000))}`, 'fire');
        log(`📊 Avg speed: ${formatBytes(avgSpeed)}/s over ${formatDuration(Math.ceil(avgElapsed))}`, 'inf');

        if (state.cancelled) {
            await writable.abort();
            for (const n of [...segNames, ...audioSegNames]) await state.ffmpeg.deleteFile(n).catch(() => { });
            setProgress(0, links.length); resetUI(); return;
        }

        await verifySegments(segNames, links, writeFileSerial);

        // ── Prepare inputs for ffmpeg ────────────────────────────────────
        const hasAudio = audioSegNames.length > 0;
        if (window._hlsInitUrl) {
            await mergeFmp4Fragments(segNames, audioSegNames, hasAudio);
        } else if (state.dlFormat !== 'ts' || hasAudio) {
            // ffmpeg needs to combine files — hand it a list, don't merge in JS
            await writeConcatLists(segNames, audioSegNames, hasAudio);
        }

        // ── Remux / concat ───────────────────────────────────────────────────────
        const remuxStart = performance.now();
        const outName = state.dlFormat === 'ts' ? 'output.ts' : 'output.mp4';

        if (state.dlFormat === 'ts' && !window._hlsInitUrl && !hasAudio) {
            // TS = raw concat in JS, skip ffmpeg entirely
            log('Writing TS to disk…', 'inf');
            const writeToDiskStart = performance.now();
            let totalBytes = 0;
            for (const n of segNames.filter(Boolean)) {
                const chunk = await state.ffmpeg.readFile(n);
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
                infoFile: `${formatBytes(totalBytes)} | ${state.dlFormat.toUpperCase()} | ${links.length} segs`,
                siteUrl: state.tab.url,
                timestamp: new Date().toISOString()
            });
            saveState();
        } else {
            // MP4 or fMP4 = need ffmpeg
            await remux(hasAudio, outName, segNames, audioSegNames);

            const remuxEnd = performance.now();
            log(`⏱ Remux done in: ${formatDuration(Math.ceil((remuxEnd - remuxStart) / 1000))}`, 'fire');

            // ── Stream output to disk ────────────────────────────────────────
            const writeToDiskStart = performance.now();
            log('✔ Remux done. Writing to disk…', 'ok');
            const outData = await readAndCleanupOutput(outName);
            await writable.write(outData instanceof Uint8Array ? outData : new Uint8Array(outData));
            await writable.close();
            const writeToDiskEnd = performance.now();
            log(`⏱ Write to disk done in: ${formatDuration(Math.ceil((writeToDiskEnd - writeToDiskStart) / 1000))}`, 'fire');
            log(`⏱ Total download time: ${formatDuration(Math.ceil((performance.now() - dlStart) / 1000))}`, 'fire');
            log(`✔ Saved → "${fileHandle.name}" (${formatBytes(outData.byteLength ?? outData.length)})`, 'ok');
            await saveHistory({
                filename: fileHandle.name,
                infoFile: `${formatBytes(outData.byteLength ?? outData.length)} | ${state.dlFormat.toUpperCase()} | ${links.length} segs`,
                siteUrl: state.tab.url,
                timestamp: new Date().toISOString()
            });
            saveState();
        }

        // ── Cleanup ffmpeg FS ────────────────────────────────────────────
        await state.ffmpeg.deleteFile(outName).catch(() => { });

        setProgress(1, 1);
        resetFfmpeg('inf');
        resetUI();

    } catch (err) {
        if (err.name === 'AbortError') { log('⚠ Save cancelled', 'err'); }
        else { log(`❌ ${err?.message || String(err)}`, 'err'); }
        saveState();
        setProgress(1, 1);
        resetFfmpeg('err');
        resetUI();
    }
}