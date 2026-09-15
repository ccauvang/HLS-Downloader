import { dom } from '../dom.js';
import { state, saveState } from '../state.js';
import { log } from '../utils/logger.js';
import { fetchSegmentViaPage, decryptSegment } from '../utils/bridge.js';
import { formatBytes, formatDuration } from '../utils/format.js';
import { setProgress, resetUI } from '../ui/progress.js';
import { saveHistory } from '../store/history-store.js';
import { loadFFmpeg, resetFfmpeg } from '../ffmpeg/engine.js';

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
        const segNames = [];
        const segExt = window._hlsInitUrl ? '.mp4' : '.ts';
        let done = 0;
        const vQueue = links.map((url, i) => async () => {
            if (state.cancelled) return;
            let buf = await fetchSegmentViaPage(url, state.currentFrameId);
            if (window._hlsHasKey && window._hlsKey) {
                const iv = window._hlsIv?.byteLength
                    ? window._hlsIv
                    : (() => { const b = new Uint8Array(16); new DataView(b.buffer).setUint32(12, i + 1); return b; })();
                buf = await decryptSegment(buf, window._hlsKey, iv);
            }
            const name = `seg${String(i).padStart(6, '0')}${segExt}`;
            const segSize = buf.byteLength;
            await state.ffmpeg.writeFile(name, new Uint8Array(buf));
            segNames[i] = name;
            state.bytesDownloaded += segSize;
            setProgress(++done, links.length, dlStart, state.bytesDownloaded);
            if (done % CONCURRENCY === 0 || done === links.length) {
                log(`✔ segs ${done - (done % CONCURRENCY || CONCURRENCY) + 1}–${done}/${links.length}`, 'ok');
            }
        });
        await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (vQueue.length) await vQueue.shift()(); }));
        log(`✔ ${links.length} segs done`, 'ok');

        if (state.cancelled) {
            await writable.abort();
            for (const n of segNames) await state.ffmpeg.deleteFile(n).catch(() => { });
            setProgress(0, links.length); resetUI(); return;
        }

        // ── Download audio segments → ffmpeg FS ─────────────────────────
        const audioSegNames = [];
        if (window._hlsAudioSegments?.length) {
            log(`Downloading ${window._hlsAudioSegments.length} audio segs…`, 'inf');
            const audioSegNames2 = [];
            let aDone = 0;
            const aQueue = window._hlsAudioSegments.map((url, i) => async () => {
                if (state.cancelled) return;
                const buf = new Uint8Array(await fetchSegmentViaPage(url, state.currentFrameId));
                const name = `aseg${String(i).padStart(6, '0')}${segExt}`;
                const segSize = buf.byteLength;
                await writeFileSerial(name, buf);
                audioSegNames2[i] = name;
                state.bytesDownloaded += segSize;
                setProgress(++aDone, window._hlsAudioSegments.length, dlStart, state.bytesDownloaded);
                if (aDone % CONCURRENCY === 0 || aDone === window._hlsAudioSegments.length) {
                    log(`✔ audio segs ${aDone - (aDone % CONCURRENCY || CONCURRENCY) + 1}–${aDone}/${window._hlsAudioSegments.length}`, 'ok');
                }
            });
            await Promise.all(Array.from({ length: CONCURRENCY }, async () => { while (aQueue.length) await aQueue.shift()(); }));
            audioSegNames.push(...audioSegNames2.filter(Boolean));
        }

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

        // ── Verify segment integrity — rare ffmpeg.wasm write race under concurrency ──
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
                if (window._hlsHasKey && window._hlsKey) {
                    const iv = window._hlsIv?.byteLength
                        ? window._hlsIv
                        : (() => { const b = new Uint8Array(16); new DataView(b.buffer).setUint32(12, i + 1); return b; })();
                    buf = await decryptSegment(buf, window._hlsKey, iv);
                }
                await writeFileSerial(name, new Uint8Array(buf));
            }
        }

        // ── Prepare inputs for ffmpeg ────────────────────────────────────
        const hasAudio = audioSegNames.length > 0;
        if (window._hlsInitUrl) {
            log('Merging fMP4 fragments…', 'inf');
            const vParts = [await state.ffmpeg.readFile('init.mp4')];
            await state.ffmpeg.deleteFile('init.mp4').catch(() => { });
            for (const n of segNames.filter(Boolean)) {
                vParts.push(await state.ffmpeg.readFile(n));
                await state.ffmpeg.deleteFile(n).catch(() => { });
            }
            const vTotal = vParts.reduce((a, c) => a + c.byteLength, 0);
            const vMerged = new Uint8Array(vTotal);
            let off = 0; for (const p of vParts) { vMerged.set(p, off); off += p.byteLength; }
            vParts.length = 0;
            await state.ffmpeg.writeFile('video_merged.mp4', vMerged);

            if (hasAudio) {
                const aParts = [await state.ffmpeg.readFile('init_a.mp4')];
                await state.ffmpeg.deleteFile('init_a.mp4').catch(() => { });
                for (const n of audioSegNames.filter(Boolean)) {
                    aParts.push(await state.ffmpeg.readFile(n));
                    await state.ffmpeg.deleteFile(n).catch(() => { });
                }
                const aTotal = aParts.reduce((a, c) => a + c.byteLength, 0);
                const aMerged = new Uint8Array(aTotal);
                let aOff = 0; for (const p of aParts) { aMerged.set(p, aOff); aOff += p.byteLength; }
                aParts.length = 0;
                await state.ffmpeg.writeFile('audio_merged.mp4', aMerged);
            }
        } else if (state.dlFormat !== 'ts' || hasAudio) {
            // ffmpeg needs to combine files — hand it a list, don't merge in JS
            const concatList = segNames.filter(Boolean).map(n => `file '${n}'`).join('\n');
            await state.ffmpeg.writeFile('concat_v.txt', new TextEncoder().encode(concatList));
            if (hasAudio) {
                const aConcatList = audioSegNames.filter(Boolean).map(n => `file '${n}'`).join('\n');
                await state.ffmpeg.writeFile('concat_a.txt', new TextEncoder().encode(aConcatList));
            }
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
            log('Remuxing with ffmpeg…', 'inf');
            const ffArgs = window._hlsInitUrl
                ? hasAudio
                    ? ['-i', 'video_merged.mp4', '-i', 'audio_merged.mp4', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', outName]
                    : ['-i', 'video_merged.mp4', '-c', 'copy', outName]
                : hasAudio
                    ? ['-f', 'concat', '-safe', '0', '-i', 'concat_v.txt', '-f', 'concat', '-safe', '0', '-i', 'concat_a.txt', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', outName]
                    : ['-f', 'concat', '-safe', '0', '-i', 'concat_v.txt', '-c', 'copy', outName];
            try { await state.ffmpeg.exec(ffArgs); } catch (e) { }

            for (const n of [...segNames, ...audioSegNames].filter(Boolean)) await state.ffmpeg.deleteFile(n).catch(() => { });

            if (state.hadCriticalFfmpegError) log('⚠ ffmpeg reported errors — output may be corrupted/incomplete', 'err');
            state.hadCriticalFfmpegError = false; // reset for next run

            // free everything ffmpeg no longer needs — output already muxed
            await state.ffmpeg.deleteFile('concat_v.txt').catch(() => { });
            await state.ffmpeg.deleteFile('concat_a.txt').catch(() => { });
            if (window._hlsAudioInitUrl) await state.ffmpeg.deleteFile('init_a.mp4').catch(() => { });

            const remuxEnd = performance.now();
            log(`⏱ Remux done in: ${formatDuration(Math.ceil((remuxEnd - remuxStart) / 1000))}`, 'fire');

            // ── Stream output to disk ────────────────────────────────────────
            const writeToDiskStart = performance.now();
            log('✔ Remux done. Writing to disk…', 'ok');
            let outData;
            try { outData = await state.ffmpeg.readFile(outName); } catch (e) {
                await new Promise(r => setTimeout(r, 800));
                outData = await state.ffmpeg.readFile(outName);
            }
            if (!outData || (outData.byteLength ?? outData.length) === 0) throw new Error('ffmpeg output empty');
            await state.ffmpeg.deleteFile(outName).catch(() => { });   // free wasm copy before the JS copy goes to disk
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