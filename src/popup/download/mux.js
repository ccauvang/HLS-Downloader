import { state } from '../state.js';
import { log } from '../utils/logger.js';

export async function mergeFmp4Fragments(segNames, audioSegNames, hasAudio) {
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
}

export async function writeConcatLists(segNames, audioSegNames, hasAudio) {
    const concatList = segNames.filter(Boolean).map(n => `file '${n}'`).join('\n');
    await state.ffmpeg.writeFile('concat_v.txt', new TextEncoder().encode(concatList));
    if (hasAudio) {
        const aConcatList = audioSegNames.filter(Boolean).map(n => `file '${n}'`).join('\n');
        await state.ffmpeg.writeFile('concat_a.txt', new TextEncoder().encode(aConcatList));
    }
}

function buildFfmpegArgs(hasAudio, outName) {
    return window._hlsInitUrl
        ? hasAudio
            ? ['-i', 'video_merged.mp4', '-i', 'audio_merged.mp4', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', outName]
            : ['-i', 'video_merged.mp4', '-c', 'copy', outName]
        : hasAudio
            ? ['-f', 'concat', '-safe', '0', '-i', 'concat_v.txt', '-f', 'concat', '-safe', '0', '-i', 'concat_a.txt', '-c', 'copy', '-map', '0:v:0', '-map', '1:a:0', outName]
            : ['-f', 'concat', '-safe', '0', '-i', 'concat_v.txt', '-c', 'copy', outName];
}

export async function remux(hasAudio, outName, segNames, audioSegNames) {
    log('Remuxing with ffmpeg…', 'inf');
    const ffArgs = buildFfmpegArgs(hasAudio, outName);
    try { await state.ffmpeg.exec(ffArgs); } catch (e) { }

    for (const n of [...segNames, ...audioSegNames].filter(Boolean)) await state.ffmpeg.deleteFile(n).catch(() => { });

    if (state.hadCriticalFfmpegError) log('⚠ ffmpeg reported errors — output may be corrupted/incomplete', 'err');
    state.hadCriticalFfmpegError = false; // reset for next run

    // free everything ffmpeg no longer needs — output already muxed
    await state.ffmpeg.deleteFile('concat_v.txt').catch(() => { });
    await state.ffmpeg.deleteFile('concat_a.txt').catch(() => { });
    if (window._hlsAudioInitUrl) await state.ffmpeg.deleteFile('init_a.mp4').catch(() => { });
}

export async function readAndCleanupOutput(outName) {
    let outData;
    try { outData = await state.ffmpeg.readFile(outName); } catch (e) {
        await new Promise(r => setTimeout(r, 800));
        outData = await state.ffmpeg.readFile(outName);
    }
    if (!outData || (outData.byteLength ?? outData.length) === 0) throw new Error('ffmpeg output empty');
    await state.ffmpeg.deleteFile(outName).catch(() => { });   // free wasm copy before the JS copy goes to disk
    return outData;
}
