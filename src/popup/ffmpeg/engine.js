import { state } from '../state.js';
import { log, shouldLogFfmpeg } from '../utils/logger.js';

const { FFmpeg } = FFmpegWASM;

function attachLogListener(ffmpeg, infoCls) {
    ffmpeg.on('log', ({ type, message }) => {
        const m = message?.trim();
        if (type === 'stderr' && m) {
            // ffmpeg reports real failures on stderr too, not just noise — these substrings
            // are the actual "something broke" signals, rest of stderr is routine verbosity
            if (/Impossible to open|Invalid data found|No such file/i.test(m)) {
                state.hadCriticalFfmpegError = true; // read later in mux.js to warn the user output may be corrupt
                log(m, 'err');
            } else if (shouldLogFfmpeg(m)) log(m, infoCls);
        }
    });
}

// Creates a fresh FFmpeg instance, wires its log listener, and stores it in
// shared state. infoCls controls the log class used for non-critical ffmpeg
// stderr lines ('inf' normally, 'err' when recreating after a failed run).
export function createFfmpeg(infoCls = 'inf') {
    const ffmpeg = new FFmpeg();
    attachLogListener(ffmpeg, infoCls);
    state.ffmpeg = ffmpeg;
    return ffmpeg;
}

export async function loadFFmpeg() {
    if (state.ffmpeg.loaded) return; // avoid re-loading wasm core on every popup/download — load once, reuse
    await state.ffmpeg.load({
        coreURL: chrome.runtime.getURL('lib/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('lib/ffmpeg-core.wasm'),
    });
}

export function resetFfmpeg(infoCls = 'inf') {
    // ffmpeg.wasm has no reliable "clear all state" API — cheaper/safer to terminate the
    // worker and spin up a fresh instance than to try to reset FS/memory in place
    try { state.ffmpeg.terminate(); } catch (e) { }
    createFfmpeg(infoCls);
}