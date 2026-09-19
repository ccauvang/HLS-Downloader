// runs once per popup session; initSettings() reruns on every settings-tab open.
// views.js rebuilds the settings DOM from scratch on each open, so listeners
// are rewired every call by design — no "wired once" guard (see chunk-delay fix history).

const DEFAULTS = {
    filename: 'video',
    concurrency: 5,
    format: 'mp4',
    saveHistory: true,
    chunkDelay: 300,
    chunkDelayEnabled: true
};

let chunkDelay = DEFAULTS.chunkDelay;
let chunkDelayEnabled = DEFAULTS.chunkDelayEnabled;
let concurrency = DEFAULTS.concurrency;
let format = DEFAULTS.format;
let saveHistory = DEFAULTS.saveHistory;
let initial = null; // snapshot of saved values, used to detect unsaved changes

// current in-memory form state, used both to save and to diff against `initial`
function currentValues() {
    return {
        filename: document.getElementById('default-filename').value.trim() || 'video',
        concurrency, format, saveHistory, chunkDelay, chunkDelayEnabled
    };
}

// enable Save button only if something actually changed from last saved state
function checkDirty() {
    const saveBtn = document.getElementById('save-btn');
    const cur = currentValues();
    const dirty = JSON.stringify(cur) !== JSON.stringify(initial);
    saveBtn.disabled = !dirty;
}

// load current settings from storage and paint the form to match — split out from
// initSettings() so the import handler can repaint values WITHOUT re-running all the
// addEventListener wiring below (re-wiring on import would stack duplicate listeners,
// since import doesn't destroy/rebuild the DOM the way switching views does)
function loadAndRepaint() {
    chrome.storage.sync.get(DEFAULTS, (s) => {
        // guards against the view being switched away (home/history) before this async
        // callback resolves — by then these elements are gone, not just hidden
        if (!document.getElementById('chunk-delay-ms')) return;
        concurrency = s.concurrency;
        format = s.format;
        saveHistory = s.saveHistory;
        chunkDelay = s.chunkDelay;
        chunkDelayEnabled = s.chunkDelayEnabled;
        document.getElementById('default-filename').value = s.filename;
        document.querySelectorAll('.batch-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.val) === concurrency);
        });
        document.getElementById('settings-fmt-mp4').className = format === 'mp4' ? 'fmt-active' : 'fmt-inactive';
        document.getElementById('settings-fmt-ts').className = format === 'ts' ? 'fmt-active' : 'fmt-inactive';
        document.getElementById('settings-hist-on').className = saveHistory ? 'fmt-active' : 'fmt-inactive';
        document.getElementById('settings-hist-off').className = !saveHistory ? 'fmt-active' : 'fmt-inactive';

        document.getElementById('chunk-delay-ms').value = chunkDelay;
        document.getElementById('chunk-delay-on').className = chunkDelayEnabled ? 'fmt-active' : 'fmt-inactive';
        document.getElementById('chunk-delay-off').className = !chunkDelayEnabled ? 'fmt-active' : 'fmt-inactive';

        // baseline for dirty-check — reset every time settings load
        initial = currentValues();
        document.getElementById('save-btn').disabled = true; // nothing changed yet
    });
}

// ── Blacklist modal helpers ────────────────────────────────────────────────
// (pure DOM-query-on-call functions, safe to define at module scope — they don't
// bind to any specific element instance at define-time, unlike addEventListener calls)
function renderBlacklist(hosts) {
    const listEl = document.getElementById('bl-list');
    const emptyEl = document.getElementById('bl-empty');
    const countEl = document.getElementById('bl-count');
    if (!listEl) return; // view switched away mid-async
    listEl.innerHTML = '';
    if (!hosts.length) {
        emptyEl.style.display = 'block';
        countEl.textContent = '';
        return;
    }
    emptyEl.style.display = 'none';
    countEl.textContent = `${hosts.length} site${hosts.length !== 1 ? 's' : ''}`;
    hosts.forEach(host => {
        const div = document.createElement('div');
        div.className = 'bl-entry';
        div.innerHTML = `
            <span class="bl-host" title="${host}">${host}</span>
            <button class="bl-delete" data-host="${host}" title="Remove">✕</button>
        `;
        div.querySelector('.bl-delete').addEventListener('click', async () => {
            const { blacklist = [] } = await chrome.storage.sync.get({ blacklist: [] });
            const next = blacklist.filter(h => h !== host);
            await chrome.storage.sync.set({ blacklist: next });
            renderBlacklist(next.sort());
        });
        listEl.appendChild(div);
    });
}

function normalizeHost(raw) {
    let host = raw.trim().toLowerCase();
    if (!host) return '';
    try { if (host.includes('://')) host = new URL(host).hostname; } catch (e) { /* not a full url, keep as-is */ }
    return host.replace(/\/.*$/, ''); // strip trailing path if pasted bare host+path
}

async function openBlacklistModal() {
    const { blacklist = [] } = await chrome.storage.sync.get({ blacklist: [] });
    renderBlacklist(blacklist.slice().sort());
    document.getElementById('bl-input').value = '';
    document.getElementById('bl-add-btn').disabled = true;
    document.getElementById('bl-modal-overlay').classList.add('show');
}

function closeBlacklistModal() {
    document.getElementById('bl-modal-overlay').classList.remove('show');
}

async function addBlacklistHost() {
    const input = document.getElementById('bl-input');
    const host = normalizeHost(input.value);
    if (!host) return;
    const { blacklist = [] } = await chrome.storage.sync.get({ blacklist: [] });
    if (!blacklist.includes(host)) blacklist.push(host);
    await chrome.storage.sync.set({ blacklist });
    input.value = '';
    document.getElementById('bl-add-btn').disabled = true;
    renderBlacklist(blacklist.slice().sort());
}

function initSettings() {
    // load current settings and paint UI to match
    loadAndRepaint();

    document.getElementById('default-filename').addEventListener('input', checkDirty);

    // Format choose (MP4 / TS)
    document.getElementById('settings-fmt-mp4').addEventListener('click', () => {
        format = 'mp4';
        document.getElementById('settings-fmt-mp4').className = 'fmt-active';
        document.getElementById('settings-fmt-ts').className = 'fmt-inactive';
        checkDirty();
    });
    document.getElementById('settings-fmt-ts').addEventListener('click', () => {
        format = 'ts';
        document.getElementById('settings-fmt-ts').className = 'fmt-active';
        document.getElementById('settings-fmt-mp4').className = 'fmt-inactive';
        checkDirty();
    });

    // Batch/concurrency buttons
    document.querySelectorAll('.batch-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            concurrency = parseInt(btn.dataset.val);
            document.querySelectorAll('.batch-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            checkDirty();
        });
    });

    // Save History toggle (ON/OFF) — read by history-store.js before writing entries
    document.getElementById('settings-hist-on').addEventListener('click', () => {
        saveHistory = true;
        document.getElementById('settings-hist-on').className = 'fmt-active';
        document.getElementById('settings-hist-off').className = 'fmt-inactive';
        checkDirty();
    });
    document.getElementById('settings-hist-off').addEventListener('click', () => {
        saveHistory = false;
        document.getElementById('settings-hist-off').className = 'fmt-active';
        document.getElementById('settings-hist-on').className = 'fmt-inactive';
        checkDirty();
    });

    document.getElementById('chunk-delay-ms').addEventListener('input', (e) => {
        chunkDelay = Math.max(0, parseInt(e.target.value) || 0);
        checkDirty();
    });
    document.getElementById('chunk-delay-on').addEventListener('click', () => {
        chunkDelayEnabled = true;
        document.getElementById('chunk-delay-on').className = 'fmt-active';
        document.getElementById('chunk-delay-off').className = 'fmt-inactive';
        checkDirty();
    });
    document.getElementById('chunk-delay-off').addEventListener('click', () => {
        chunkDelayEnabled = false;
        document.getElementById('chunk-delay-off').className = 'fmt-active';
        document.getElementById('chunk-delay-on').className = 'fmt-inactive';
        checkDirty();
    });

    // Persist to chrome.storage.sync, refresh baseline + disable save btn again
    document.getElementById('save-btn').addEventListener('click', () => {
        const filename = document.getElementById('default-filename').value.trim() || 'video';
        chrome.storage.sync.set({ filename, concurrency, format, saveHistory, chunkDelay, chunkDelayEnabled }, () => {
            const msg = document.getElementById('saved-msg');
            msg.classList.add('show');
            setTimeout(() => msg.classList.remove('show'), 2000);
            initial = currentValues();
            document.getElementById('save-btn').disabled = true;
        });
    });

    // ── Blacklist modal wiring ────────────────────────────────────────────
    // lives inside initSettings() (not module scope) so it rewires every settings-tab
    // open — views.js rebuilds this DOM fresh each time, module-scope listeners would
    // only ever bind to the very first (now-discarded) copy of these elements, which
    // is exactly why the buttons went dead after leaving and coming back
    document.getElementById('edit-blacklist-btn').addEventListener('click', openBlacklistModal);
    document.getElementById('bl-modal-close').addEventListener('click', closeBlacklistModal);
    document.getElementById('bl-modal-overlay').addEventListener('click', (e) => {
        if (e.target.id === 'bl-modal-overlay') closeBlacklistModal(); // click outside card = close
    });
    document.getElementById('bl-add-btn').addEventListener('click', addBlacklistHost);
    document.getElementById('bl-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') addBlacklistHost();
    });
    document.getElementById('bl-input').addEventListener('input', (e) => {          // NEW
        document.getElementById('bl-add-btn').disabled = !e.target.value.trim();
    });

    // ── Export / Import wiring ────────────────────────────────────────────
    document.getElementById('export-btn').addEventListener('click', async () => {
        const data = await chrome.storage.sync.get({
            filename: 'video', concurrency: 5, format: 'mp4', saveHistory: true,
            chunkDelay: 300, chunkDelayEnabled: true, blacklist: []
        });
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'hls-downloader-settings.json';
        a.click();
        URL.revokeObjectURL(url);
    });

    document.getElementById('import-btn').addEventListener('click', () => {
        document.getElementById('import-file').click();
    });

    document.getElementById('import-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const data = JSON.parse(await file.text());
            const allowed = ['filename', 'concurrency', 'format', 'saveHistory', 'chunkDelay', 'chunkDelayEnabled', 'blacklist'];
            const clean = {};
            for (const k of allowed) if (k in data) clean[k] = data[k];
            if ('blacklist' in clean) {
                clean.blacklist = Array.isArray(clean.blacklist)
                    ? clean.blacklist.filter(h => typeof h === 'string')
                    : [];
            }
            await chrome.storage.sync.set(clean);
            loadAndRepaint(); // repaint form values only — does NOT re-run this wiring block,
            // so listeners don't stack (see loadAndRepaint's own comment)
            const msg = document.getElementById('saved-msg');
            msg.textContent = 'Settings imported!';
            msg.classList.add('show');
            setTimeout(() => { msg.classList.remove('show'); msg.textContent = 'Settings saved!'; }, 2000);
        } catch (err) {
            alert('Invalid settings file: ' + err.message);
        }
        e.target.value = ''; // allow re-importing same filename later
    });
}

window.hlsSettingsInit = initSettings;
// no self-call here — views.js's script.onload already invokes hlsSettingsInit()
// once the script finishes loading; calling it again here double-wired every
// listener (export/import firing twice) on the very first Settings open