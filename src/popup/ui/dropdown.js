import { dom } from '../dom.js';
import { state } from '../state.js';

export function updateDropdown() {
    dom.detectedLabel.textContent = `Detected streams (${state.detectedM3u8.length})`;
    dom.m3u8Options.innerHTML = ''; // full rebuild each call — list is small, simpler than diffing against stale option nodes

    if (!state.detectedM3u8.length) {
        dom.m3u8Selected.textContent = '— no streams detected yet —';
        state.m3u8Value = '';
        return;
    }

    // box text only changes on pick or when empty — without this it keeps saying "no streams detected yet" after streams arrive
    if (!state.m3u8Value) dom.m3u8Selected.textContent = `— select a stream (${state.detectedM3u8.length}) —`;

    state.detectedM3u8.forEach((entry, i) => {
        // always objects: bare {url, frameId} from background, upgraded to {url, label, ...} once detectStreamInfo() resolves
        const url = entry.url;
        const label = entry.label ? ` — ${entry.label}` : '';
        const shortUrl = url.length > 35 ? url.slice(0, 35) + '...' : url;
        const opt = document.createElement('div');
        opt.className = 'custom-option';
        opt.textContent = `${i + 1}. ${shortUrl}${label}`;
        opt.title = url; // full url on hover since display text is truncated
        opt.addEventListener('click', (e) => {
            e.stopPropagation(); // must not bubble to the select-toggle click handler below, or it'd immediately reopen after this closes it
            state.m3u8Value = url;
            state.currentFrameId = entry.frameId ?? 0; // needed later so segment fetches proxy through the right iframe
            dom.m3u8Selected.textContent = opt.textContent;
            document.getElementById('m3u8-url').value = url; // mirror into the manual-paste field so parse-btn can reuse it
            dom.m3u8Options.querySelectorAll('.custom-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            dom.m3u8SelectEl.classList.remove('open');
        });
        dom.m3u8Options.appendChild(opt);
    });
}

export function wireDropdown() {
    dom.m3u8SelectEl.addEventListener('click', () => {
        dom.m3u8SelectEl.classList.toggle('open');
    });
    // close on any outside click — custom select has no native blur/focus-out to hook into
    document.addEventListener('click', (e) => {
        if (!dom.m3u8SelectEl.contains(e.target)) dom.m3u8SelectEl.classList.remove('open');
    });
}