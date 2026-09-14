// settings.js — load/save extension options (chrome.storage.sync)
// runs once per popup session; initSettings() reruns on every settings-tab open
// but listenersWired guards against duplicate event bindings (same DOM, views.js reuses script)

const DEFAULTS = { filename: 'video', concurrency: 5, format: 'mp4', saveHistory: true };
let concurrency = DEFAULTS.concurrency;
let format = DEFAULTS.format;
let saveHistory = DEFAULTS.saveHistory;
let initial = null; // snapshot of saved values, used to detect unsaved changes
let listenersWired = false; // prevent re-attaching listeners on repeat opens

// current in-memory form state, used both to save and to diff against `initial`
function currentValues() {
    return {
        filename: document.getElementById('default-filename').value.trim() || 'video',
        concurrency, format, saveHistory
    };
}

// enable Save button only if something actually changed from last saved state
function checkDirty() {
    const saveBtn = document.getElementById('save-btn');
    const cur = currentValues();
    const dirty = JSON.stringify(cur) !== JSON.stringify(initial);
    saveBtn.disabled = !dirty;
}

function initSettings() {
    // load current settings from storage and paint UI to match
    chrome.storage.sync.get(DEFAULTS, (s) => {
        concurrency = s.concurrency;
        format = s.format;
        saveHistory = s.saveHistory;
        document.getElementById('default-filename').value = s.filename;
        document.querySelectorAll('.batch-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.val) === concurrency);
        });
        document.getElementById('settings-fmt-mp4').className = format === 'mp4' ? 'fmt-active' : 'fmt-inactive';
        document.getElementById('settings-fmt-ts').className = format === 'ts' ? 'fmt-active' : 'fmt-inactive';
        document.getElementById('settings-hist-on').className = saveHistory ? 'fmt-active' : 'fmt-inactive';
        document.getElementById('settings-hist-off').className = !saveHistory ? 'fmt-active' : 'fmt-inactive';

        // baseline for dirty-check — reset every time settings load
        initial = currentValues();
        document.getElementById('save-btn').disabled = true; // nothing changed yet
    });

    // listeners only get wired once — DOM/script instance persists across
    // settings-tab open/close within same popup session (see views.js)
    if (listenersWired) return;
    listenersWired = true;

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

    // Persist to chrome.storage.sync, refresh baseline + disable save btn again
    document.getElementById('save-btn').addEventListener('click', () => {
        const filename = document.getElementById('default-filename').value.trim() || 'video';
        chrome.storage.sync.set({ filename, concurrency, format, saveHistory }, () => {
            const msg = document.getElementById('saved-msg');
            msg.classList.add('show');
            setTimeout(() => msg.classList.remove('show'), 2000);
            initial = currentValues();
            document.getElementById('save-btn').disabled = true;
        });
    });
}

window.hlsSettingsInit = initSettings;
initSettings();