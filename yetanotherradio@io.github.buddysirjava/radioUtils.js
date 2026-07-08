import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

let _ = (s) => s;

export function initTranslations(gettextFunction) {
    _ = gettextFunction;
}

export const USER_AGENT = 'yetanotherradio-extension/1.0';
export const STORAGE_PATH = GLib.build_filenamev([
    GLib.get_user_state_dir(),
    'yetanotherradio',
    'stations.json',
]);

export function getDefaultRecordingsDir() {
    return GLib.build_filenamev([
        GLib.get_user_state_dir(),
        'yetanotherradio',
        'recordings',
    ]);
}

export function getCustomRecordingsDir(settings = null) {
    return settings?.get_string('recordings-directory')?.trim();
}

export function connectRecordingsDirChanged(settings, callback) {
    return settings?.connect('changed::recordings-directory', callback);
}

export function getRecordingsDir(settings = null) {
    const customDir = getCustomRecordingsDir(settings);
    if (customDir)
        return customDir;
    return getDefaultRecordingsDir();
}

export function getSessionsIndexPath() {
    return GLib.build_filenamev([
        GLib.get_user_state_dir(),
        'yetanotherradio',
        'recording-sessions.json',
    ]);
}

export function ensureStorageFile() {
    try {
        const dir = GLib.path_get_dirname(STORAGE_PATH);
        if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) {
            GLib.mkdir_with_parents(dir, 0o755);
        }

        if (!GLib.file_test(STORAGE_PATH, GLib.FileTest.EXISTS)) {
            GLib.file_set_contents(STORAGE_PATH, '[]');
        }
    } catch (error) {
        logError(error, 'Failed to ensure storage file exists');
        throw new Error(_('Could not create storage directory. Check file permissions.'));
    }
}

export async function loadStations() {
    try {
        ensureStorageFile();
    } catch (error) {
        logError(error, 'Failed to ensure storage file');
        return [];
    }

    try {
        const file = Gio.File.new_for_path(STORAGE_PATH);
        const [success, contents] = await new Promise((resolve, reject) => {
            file.load_contents_async(null, (obj, res) => {
                try {
                    const result = obj.load_contents_finish(res);
                    resolve(result);
                } catch (e) {
                    reject(e);
                }
            });
        });

        if (!success) return [];

        const text = new TextDecoder().decode(contents);
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
            return [];
        return parsed
            .filter(station => typeof station === 'object' && station)
            .map(_sanitizeStation);
    } catch (error) {
        logError(error, 'Failed to load stations');
        if (error.code === Gio.IOErrorEnum.NOT_FOUND || error.code === GLib.IOErrorEnum.NOT_FOUND) {
            log('Stations file not found, returning empty list');
            return [];
        }
        return [];
    }
}

export function saveStations(stations) {
    try {
        ensureStorageFile();
    } catch (error) {
        logError(error, 'Failed to ensure storage file');
        throw error;
    }

    try {
        const sanitized = stations
            .filter(station => station?.uuid && station?.url)
            .map(_sanitizeStation);
        const json = JSON.stringify(sanitized, null, 2);
        GLib.file_set_contents(STORAGE_PATH, json);
        return sanitized;
    } catch (error) {
        logError(error, 'Failed to save stations');
        if (error.code === GLib.IOErrorEnum.PERMISSION_DENIED) {
            throw new Error(_('Permission denied. Cannot save stations file.'));
        }
        throw new Error(_('Failed to save stations: %s').format(error.message || _('Unknown error')));
    }
}

export function stationDisplayName(station) {
    const base = station?.name?.trim() || station?.url || _('Unnamed station');
    const country = station?.countrycode ? ` (${station.countrycode})` : '';
    return `${base}${country}`;
}

const RECORDING_AUDIO_EXTENSION_PATTERN = /\.(flac|mp3|ogg|opus|wav|m4a|aac)$/i;

export function sanitizeRecordingFilename(value, fallback = 'track') {
    const cleaned = String(value ?? '')
        .trim()
        .replace(RECORDING_AUDIO_EXTENSION_PATTERN, '')
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/\s+/g, ' ')
        .substring(0, 120);
    return cleaned || fallback;
}

export function buildRecordingTrackBasename(artist, title, stationName) {
    const safeArtist = sanitizeRecordingFilename(artist, '');
    const safeTitle = sanitizeRecordingFilename(title, sanitizeRecordingFilename(stationName, 'track'));
    if (safeArtist && safeArtist !== safeTitle)
        return `${safeArtist} - ${safeTitle}`;
    return safeTitle;
}

export function buildRecordingTrackFilename(artist, title, stationName, format = 'mp3', usedNames = new Set()) {
    const basename = buildRecordingTrackBasename(artist, title, stationName);
    let filename = `${basename}.${format}`;
    let counter = 2;

    while (usedNames.has(filename.toLowerCase())) {
        filename = `${basename} (${counter}).${format}`;
        counter += 1;
    }

    usedNames.add(filename.toLowerCase());
    return { basename, filename };
}

export function getRecordingStationDirName(station) {
    return sanitizeRecordingFilename(stationDisplayName(station), 'recording');
}

export function listRecordingTrackFilenames(folderName, settings = null) {
    const dirPath = getRecordingSessionDir(folderName, settings);
    const usedNames = new Set();

    if (!GLib.file_test(dirPath, GLib.FileTest.IS_DIR))
        return usedNames;

    const dir = Gio.File.new_for_path(dirPath);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name,type', Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        return usedNames;
    }

    let info;
    while ((info = enumerator.next_file(null))) {
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            continue;

        const filename = info.get_name();
        if (RECORDING_AUDIO_EXTENSION_PATTERN.test(filename))
            usedNames.add(filename.toLowerCase());
    }

    return usedNames;
}

export function ensureRecordingsDir(settings = null) {
    const recordingsDir = getRecordingsDir(settings);

    try {
        if (!GLib.file_test(recordingsDir, GLib.FileTest.IS_DIR))
            GLib.mkdir_with_parents(recordingsDir, 0o755);
    } catch (error) {
        logError(error, 'Failed to ensure recordings directory exists');
        throw new Error(_('Could not create recordings directory. Check file permissions.'));
    }
}

export function ensureSessionsIndex() {
    try {
        const dir = GLib.path_get_dirname(getSessionsIndexPath());
        if (!GLib.file_test(dir, GLib.FileTest.IS_DIR))
            GLib.mkdir_with_parents(dir, 0o755);

        const sessionsIndexPath = getSessionsIndexPath();
        if (!GLib.file_test(sessionsIndexPath, GLib.FileTest.EXISTS))
            GLib.file_set_contents(sessionsIndexPath, '[]');
    } catch (error) {
        logError(error, 'Failed to ensure recording sessions index exists');
        throw new Error(_('Could not create recording sessions index. Check file permissions.'));
    }
}

function _loadFileContentsAsync(path) {
    const file = Gio.File.new_for_path(path);
    return new Promise((resolve, reject) => {
        file.load_contents_async(null, (obj, res) => {
            try {
                resolve(obj.load_contents_finish(res));
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function _migrateSessionsIndexFromRecordingsDir(settings = null) {
    const newPath = getSessionsIndexPath();
    const oldPath = GLib.build_filenamev([getRecordingsDir(settings), 'sessions.json']);

    if (oldPath === newPath || !GLib.file_test(oldPath, GLib.FileTest.EXISTS))
        return;

    if (GLib.file_test(newPath, GLib.FileTest.EXISTS)) {
        try {
            Gio.File.new_for_path(oldPath).delete(null);
        } catch (error) {
            logError(error, 'Failed to remove legacy sessions.json from recordings folder');
        }
        return;
    }

    try {
        const [, contents] = await _loadFileContentsAsync(oldPath);
        GLib.file_set_contents(newPath, contents);
        Gio.File.new_for_path(oldPath).delete(null);
    } catch (error) {
        logError(error, 'Failed to migrate recording sessions index');
    }
}

async function _loadRecordingSessionsIndex(settings = null) {
    try {
        const [, contents] = await _loadFileContentsAsync(getSessionsIndexPath());
        const text = new TextDecoder().decode(contents);
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed))
            return [];

        return parsed
            .filter(session => typeof session === 'object' && session?.id)
            .map(_sanitizeRecordingSession);
    } catch (error) {
        logError(error, 'Failed to load recording sessions index');
        return [];
    }
}

export function ensureRecordingSessionDir(sessionId, settings = null) {
    ensureRecordingsDir(settings);
    const sessionDir = getRecordingSessionDir(sessionId, settings);
    if (!GLib.file_test(sessionDir, GLib.FileTest.IS_DIR))
        GLib.mkdir_with_parents(sessionDir, 0o755);
    return sessionDir;
}

export function getRecordingSessionDir(folderName = null, settings = null, session = null) {
    const baseDir = session?.recordingsDir || getRecordingsDir(settings);
    const name = session?.folderName || session?.id || folderName;
    return GLib.build_filenamev([baseDir, name]);
}

export function getRecordingSessionPath(filename, settings = null, session = null) {
    return GLib.build_filenamev([getRecordingSessionDir(null, settings, session), filename]);
}

function _sessionStorageKey(session, settings = null) {
    const dir = session.recordingsDir || getRecordingsDir(settings);
    const folder = session.folderName || session.id || '';
    return `${dir}/${folder}`;
}

export async function loadRecordingSessions(settings = null) {
    try {
        ensureSessionsIndex();
        ensureRecordingsDir(settings);
        await _migrateSessionsIndexFromRecordingsDir(settings);
    } catch (error) {
        logError(error, 'Failed to ensure recording sessions index');
        return [];
    }

    const indexed = await _loadRecordingSessionsIndex(settings);
    return _mergeRecordingSessions(indexed, discoverRecordingSessionsFromDisk(settings), settings);
}

function _mergeRecordingSessions(indexed, discovered, settings = null) {
    const sessions = new Map();
    const indexedFolderKeys = new Set();

    for (const session of indexed) {
        sessions.set(session.id, session);
        indexedFolderKeys.add(_sessionStorageKey(session, settings));
    }

    for (const session of discovered) {
        const folderKey = _sessionStorageKey(session, settings);
        if (!indexedFolderKeys.has(folderKey))
            sessions.set(folderKey, session);
    }

    return [...sessions.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}

function _scanRecordingsDirectory(recordingsDir) {
    const sessions = [];
    if (!recordingsDir || !GLib.file_test(recordingsDir, GLib.FileTest.IS_DIR))
        return sessions;

    const dir = Gio.File.new_for_path(recordingsDir);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name,type', Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        logError(error, 'Failed to enumerate recordings directory');
        return sessions;
    }

    let info;
    while ((info = enumerator.next_file(null))) {
        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            continue;

        const sessionId = info.get_name();
        if (sessionId.startsWith('.'))
            continue;

        const sessionDir = GLib.build_filenamev([recordingsDir, sessionId]);
        const tracks = _scanSessionTracks(sessionDir);
        if (!tracks.length)
            continue;

        const sessionStat = dir.get_child(sessionId).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const startedAt = (sessionStat?.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED) || 0) * 1000 || Date.now();

        sessions.push(_sanitizeRecordingSession({
            id: sessionId,
            folderName: sessionId,
            stationName: sessionId,
            recordingsDir,
            startedAt,
            endedAt: startedAt,
            format: tracks[0].filename.split('.').pop() || 'mp3',
            tracks,
        }));
    }

    return sessions;
}

function _scanSessionTracks(sessionDir) {
    const tracks = [];
    const dir = Gio.File.new_for_path(sessionDir);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name,type', Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        return tracks;
    }

    let info;
    while ((info = enumerator.next_file(null))) {
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            continue;

        const filename = info.get_name();
        if (!RECORDING_AUDIO_EXTENSION_PATTERN.test(filename))
            continue;

        const title = filename.replace(/\.[^.]+$/, '');
        const fileStat = dir.get_child(filename).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        const modifiedAt = (fileStat?.get_attribute_uint64(Gio.FILE_ATTRIBUTE_TIME_MODIFIED) || 0) * 1000 || Date.now();

        tracks.push(_sanitizeRecordingTrack({
            title,
            artist: '',
            filename,
            startedAt: modifiedAt,
            endedAt: modifiedAt,
            durationSeconds: 0,
        }));
    }

    tracks.sort((a, b) => a.startedAt - b.startedAt);
    tracks.forEach((track, index) => {
        track.index = index + 1;
    });
    return tracks;
}

export function discoverRecordingSessionsFromDisk(settings = null) {
    const dirs = new Set([
        getRecordingsDir(settings),
        getDefaultRecordingsDir(),
    ]);

    const sessions = [];
    for (const recordingsDir of dirs)
        sessions.push(..._scanRecordingsDirectory(recordingsDir));

    return _mergeRecordingSessions([], sessions);
}

export function saveRecordingSessions(sessions, settings = null) {
    try {
        ensureSessionsIndex();
    } catch (error) {
        logError(error, 'Failed to ensure recording sessions index');
        throw error;
    }

    try {
        const sanitized = sessions
            .filter(session => session?.id)
            .map(_sanitizeRecordingSession);
        const json = JSON.stringify(sanitized, null, 2);
        GLib.file_set_contents(getSessionsIndexPath(), json);
        return sanitized;
    } catch (error) {
        logError(error, 'Failed to save recording sessions');
        throw new Error(_('Failed to save recording sessions: %s').format(error.message || _('Unknown error')));
    }
}

export async function deleteRecordingSession(sessionId, settings = null) {
    const sessions = await loadRecordingSessions(settings);
    const session = sessions.find(entry => entry.id === sessionId);
    const filtered = sessions.filter(entry => entry.id !== sessionId);
    saveRecordingSessions(filtered, settings);

    if (!session)
        return;

    for (const track of session.tracks || []) {
        if (!track.filename)
            continue;

        const trackPath = getRecordingSessionPath(track.filename, settings, session);
        if (!GLib.file_test(trackPath, GLib.FileTest.EXISTS))
            continue;

        try {
            Gio.File.new_for_path(trackPath).trash(null);
        } catch (error) {
            logError(error, `Failed to delete recording track ${track.filename}`);
        }
    }

    const sessionDir = getRecordingSessionDir(null, settings, session);
    if (!GLib.file_test(sessionDir, GLib.FileTest.IS_DIR))
        return;

    const dir = Gio.File.new_for_path(sessionDir);
    let enumerator;
    try {
        enumerator = dir.enumerate_children('standard::name,type', Gio.FileQueryInfoFlags.NONE, null);
    } catch (error) {
        return;
    }

    let hasAudioFiles = false;
    let info;
    while ((info = enumerator.next_file(null))) {
        if (info.get_file_type() !== Gio.FileType.REGULAR)
            continue;

        if (RECORDING_AUDIO_EXTENSION_PATTERN.test(info.get_name())) {
            hasAudioFiles = true;
            break;
        }
    }

    if (!hasAudioFiles) {
        try {
            dir.trash(null);
        } catch (error) {
            logError(error, 'Failed to remove empty station recording folder');
        }
    }
}

export function generateRecordingSessionId() {
    return `rec-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export function generateRecordingTrackId() {
    return `track-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export function formatDuration(seconds) {
    const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0)
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function formatRecordingDate(timestamp) {
    if (!timestamp)
        return '';
    const date = new Date(timestamp);
    return date.toLocaleString();
}

export function truncateString(str, maxLength = 30) {
    if (!str || str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
}

export function validateUrl(url) {
    if (!url || typeof url !== 'string')
        return false;

    const urlPattern = /^(https?|icecast|shoutcast|mms|rtsp|rtmp):\/\/.+/i;
    return urlPattern.test(url.trim());
}

export function generateManualStationUuid() {
    return `manual-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
}

export function createStationFromRadioBrowser(station) {
    return {
        uuid: station.stationuuid,
        name: station.name,
        url: station.url_resolved || station.url,
        homepage: station.homepage,
        favicon: station.favicon,
        countrycode: station.countrycode,
    };
}

export function createManualStation(name, url) {
    return {
        uuid: generateManualStationUuid(),
        name: name,
        url: url,
        homepage: '',
        favicon: '',
        countrycode: '',
    };
}

export class RadioBrowserClient {
    constructor(settings = null) {
        const timeout = settings?.get_int('http-request-timeout') ?? 10;
        this._session = new Soup.Session({
            user_agent: USER_AGENT,
            timeout: timeout,
        });
        this._servers = null;
        this._settings = settings;
        this._timeoutId = null;
    }

    async searchStations(query) {
        const trimmed = query?.trim();
        if (!trimmed)
            return [];

        await this._ensureServers();

        const shuffled = this._servers.slice().sort(() => Math.random() - 0.5);
        let lastError = null;
        const maxRetries = 3;

        const searchLimit = this._settings?.get_int('search-result-limit') ?? 25;
        for (const baseUrl of shuffled) {
            for (let attempt = 0; attempt < maxRetries; attempt++) {
                try {
                    const url = `${baseUrl}/json/stations/search?name=${encodeURIComponent(trimmed)}` +
                        `&limit=${searchLimit}&hidebroken=true`;
                    return await this._fetchJson(url);
                } catch (error) {
                    lastError = error;
                    if (attempt < maxRetries - 1) {
                        const delay = Math.pow(2, attempt) * 100;
                        if (this._timeoutId) {
                            GLib.source_remove(this._timeoutId);
                        }
                        await new Promise(resolve => {
                            this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                                this._timeoutId = null;
                                resolve();
                                return false;
                            });
                        });
                    } else {
                        logError(error, `Failed to query ${baseUrl} after ${maxRetries} attempts`);
                    }
                }
            }
        }

        if (lastError) {
            if (lastError.message && lastError.message.includes('timeout')) {
                throw new Error(_('Network request timed out. Please check your internet connection.'));
            }
            throw new Error(_('All radio servers failed to respond. Please try again later.'));
        }
        throw new Error(_('All radio servers failed to respond.'));
    }

    async _ensureServers() {
        if (this._servers?.length)
            return;

        try {
            const payload = await this._fetchJson('https://all.api.radio-browser.info/json/servers');
            const hosts = payload
                .map(server => server?.name)
                .filter(Boolean)
                .map(name => `https://${name}`);

            if (hosts.length > 0) {
                this._servers = hosts;
                return;
            }
        } catch (e) {
            logError(e, 'Failed to fetch servers from radio-browser.info, using fallbacks');
        }

        this._servers = [
            'https://de1.api.radio-browser.info',
            'https://fr1.api.radio-browser.info',
            'https://at1.api.radio-browser.info',
            'https://nl1.api.radio-browser.info'
        ];
    }

    async _fetchJson(url) {
        const message = Soup.Message.new('GET', url);

        const bytes = await new Promise((resolve, reject) => {
            this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                null,
                (session, result) => {
                    try {
                        const data = session.send_and_read_finish(result);
                        resolve(data.toArray());
                    } catch (error) {
                        if (error.message && error.message.includes('timeout')) {
                            reject(new Error(_('Network request timed out. Please check your internet connection.')));
                        } else {
                            reject(error);
                        }
                    }
                }
            );
        });

        if (message.status_code < 200 || message.status_code >= 300) {
            if (message.status_code === 404) {
                throw new Error(_('Resource not found. The server may be unavailable.'));
            } else if (message.status_code >= 500) {
                throw new Error(_('Server error. Please try again later.'));
            } else {
                throw new Error(_('Request failed with status %s').format(message.status_code));
            }
        }

        try {
            return JSON.parse(new TextDecoder().decode(bytes));
        } catch (error) {
            throw new Error(_('Invalid response from server.'));
        }
    }

    destroy() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
    }
}

function _sanitizeStation(station) {
    return {
        uuid: station.uuid || station.stationuuid || '',
        name: station.name || '',
        url: station.url || station.url_resolved || '',
        homepage: station.homepage || '',
        favicon: station.favicon || '',
        countrycode: station.countrycode || '',
        favorite: station.favorite || false,
        lastPlayed: station.lastPlayed || null,
    };
}

function _sanitizeRecordingTrack(track) {
    return {
        id: track.id || generateRecordingTrackId(),
        index: Number.isFinite(track.index) ? track.index : 0,
        title: track.title || '',
        artist: track.artist || '',
        filename: track.filename || '',
        startedAt: track.startedAt || null,
        endedAt: track.endedAt || null,
        durationSeconds: Number.isFinite(track.durationSeconds) ? track.durationSeconds : 0,
    };
}

function _sanitizeRecordingSession(session) {
    const tracks = Array.isArray(session.tracks)
        ? session.tracks.map(_sanitizeRecordingTrack)
        : [];

    return {
        id: session.id || generateRecordingSessionId(),
        folderName: session.folderName ||
            sanitizeRecordingFilename(session.stationName, session.id || generateRecordingSessionId()),
        stationUuid: session.stationUuid || '',
        stationName: session.stationName || '',
        stationUrl: session.stationUrl || '',
        startedAt: session.startedAt || null,
        endedAt: session.endedAt || null,
        format: session.format || 'mp3',
        recordingsDir: session.recordingsDir || '',
        tracks,
    };
}

