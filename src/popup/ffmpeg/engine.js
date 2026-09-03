import { state } from '../state.js';
import { log, shouldLogFfmpeg } from '../utils/logger.js';

const { FFmpeg } = FFmpegWASM;

function attachLogListener(ffmpeg, infoCls) {
    ffmpeg.on('log', ({ type, message }) => {
        const m = message?.trim();
        if (type === 'stderr' && m) {
            if (/Impossible to open|Invalid data found|No such file/i.test(m)) {
                state.hadCriticalFfmpegError = true;
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
    if (state.ffmpeg.loaded) return;
    await state.ffmpeg.load({
        coreURL: chrome.runtime.getURL('lib/ffmpeg-core.js'),
        wasmURL: chrome.runtime.getURL('lib/ffmpeg-core.wasm'),
    });
}

export function resetFfmpeg(infoCls = 'inf') {
    try { state.ffmpeg.terminate(); } catch (e) { }
    createFfmpeg(infoCls);
}