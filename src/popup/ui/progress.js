import { dom } from '../dom.js';
import { state } from '../state.js';
import { formatBytes, formatDuration } from '../utils/format.js';

export function setProgress(v, total, startTime, bytesDone) {
    const pct = ((v / total) * 100).toFixed(1);
    dom.barEl.style.width = pct + '%';
    dom.percentEl.textContent = pct + '%';
    if (startTime && v > 0) {
        const elapsed = (performance.now() - startTime) / 1000;
        const concurrency = state.CONCURRENCY_SETTING || 1;
        const delayMs = (state.chunkDelayEnabled && state.chunkDelay > 0) ? state.chunkDelay : 0;

        // Chunk delay is applied per-worker, and CONCURRENCY workers run in parallel, so roughly
        // one "wave" of delay happens per `concurrency` segments completed — not one delay per
        // segment. Estimating delaySoFar this way (rather than tracking it live with an
        // accumulator) avoids a race: a shared counter written by N concurrent workers would
        // overcount delay time by ~Nx and could corrupt the rate calc below (hit this exact bug once).
        const wavesDone = Math.floor(v / concurrency);
        const delaySoFar = (wavesDone * delayMs) / 1000;
        const pureElapsed = Math.max(elapsed - delaySoFar, elapsed * 0.01, 0.001); // floor guards against edge-case overshoot

        const pureRate = v / pureElapsed;
        const remainingDownload = (total - v) / pureRate;

        const wavesRemaining = Math.ceil((total - v) / concurrency);
        const remainingDelay = (wavesRemaining * delayMs) / 1000;

        // ETA = time left fetching (at the real, delay-excluded rate) + time left waiting out
        // future delays. Recomputed from scratch every call, so toggling the delay setting or
        // changing chunkDelay mid-download self-corrects immediately — nothing here is cumulative
        // or can get stuck from stale state.
        const remaining = remainingDownload + remainingDelay;
        const bytesPerSec = bytesDone / elapsed; // real effective throughput — unchanged
        dom.barEtaEl.textContent =
            `↓ ${formatBytes(bytesPerSec)}/s · ${formatDuration(Math.ceil(remaining))}`;
    } else {
        dom.barEtaEl.textContent = '';
    }
}

// locks everything that rewrites state a running download reads live:
// window._hls* (parse), state.currentFrameId (dropdown), state.dlFormat (fmt btns), page reload
export function lockInputs(on) {
    for (const id of ['reload-btn', 'parse-btn', 'm3u8-url', 'fmt-mp4', 'fmt-ts'])
        document.getElementById(id).disabled = on;
    dom.m3u8SelectEl.classList.toggle('locked', on); // custom div select has no native disabled
}

export function resetUI() {
    dom.startBtn.disabled = false;
    dom.cancelBtn.disabled = true;
    lockInputs(false); // replaces the old dom.reloadBtn.disabled = false line
}