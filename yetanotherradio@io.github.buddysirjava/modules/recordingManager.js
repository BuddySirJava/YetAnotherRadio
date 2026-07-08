import GLib from 'gi://GLib';

import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    buildRecordingTrackFilename,
    ensureRecordingsDir,
    ensureRecordingSessionDir,
    generateRecordingSessionId,
    generateRecordingTrackId,
    getRecordingsDir,
    getRecordingSessionPath,
    getRecordingStationDirName,
    listRecordingTrackFilenames,
    loadRecordingSessions,
    saveRecordingSessions,
    stationDisplayName,
} from '../radioUtils.js';

function _normalizeTitle(title) {
    const value = String(title ?? '').trim();
    if (!value || value === _('Unknown title'))
        return '';
    return value;
}

export default class RecordingManager {
    constructor(settings, playbackManager) {
        this._settings = settings;
        this._playbackManager = playbackManager;
        this._listeners = {};
        this._recording = false;
        this._session = null;
        this._currentTrack = null;
        this._trackIndex = 0;
        this._format = 'mp3';
        this._lastTrackTitle = '';
        this._usedFilenames = new Set();
        this._trackRotatePending = false;
        this._station = null;
        this._currentMetadata = null;
        this._playbackState = 'stopped';
    }

    addListener(event, fn) {
        (this._listeners[event] ||= []).push(fn);
    }

    removeListener(event, fn) {
        const list = this._listeners[event];
        if (list) {
            const idx = list.indexOf(fn);
            if (idx !== -1)
                list.splice(idx, 1);
        }
    }

    _emit(event, ...args) {
        (this._listeners[event] || []).forEach(fn => fn(...args));
    }

    isRecording() {
        return this._recording;
    }

    toggle(station, metadata, playbackState) {
        if (this._recording)
            return this.stop();

        if (!station || playbackState !== 'playing') {
            Main.notify(_('Yet Another Radio'), _('Start playing a station before recording.'));
            return false;
        }

        return this.start(station, metadata);
    }

    start(station, metadata) {
        if (this._recording)
            return true;

        if (!this._playbackManager.setRecordingOutputPath) {
            Main.notifyError(_('Recording error'), _('Playback is not ready for recording.'));
            return false;
        }

        try {
            ensureRecordingsDir(this._settings);

            this._station = station;
            this._currentMetadata = metadata || {};
            this._playbackState = 'playing';
            this._trackIndex = 0;
            this._format = 'mp3';
            this._lastTrackTitle = '';
            this._trackRotatePending = false;

            const folderName = getRecordingStationDirName(station);
            this._usedFilenames = listRecordingTrackFilenames(folderName, this._settings);

            this._session = {
                id: generateRecordingSessionId(),
                folderName,
                stationUuid: station.uuid || '',
                stationName: stationDisplayName(station),
                stationUrl: station.url || '',
                startedAt: Date.now(),
                endedAt: null,
                format: this._format,
                tracks: [],
            };

            this._startTrack(metadata);

            if (!this._playbackManager.setRecordingActive(true))
                throw new Error(_('Failed to start recording branch'));

            this._recording = true;
            this._emit('onRecordingChanged', true);
            return true;
        } catch (error) {
            logError(error, 'Failed to start recording');
            this._playbackManager.stopRecordingBranch();
            this._session = null;
            this._recording = false;
            this._emit('onRecordingChanged', false);
            Main.notifyError(_('Recording error'), GLib.markup_escape_text(String(error.message || error), -1));
            return false;
        }
    }

    stop() {
        if (!this._recording)
            return;

        const sessionToSave = this._session;

        this._finalizeCurrentTrack();
        this._playbackManager.stopRecordingBranch();

        if (sessionToSave) {
            sessionToSave.endedAt = Date.now();
            sessionToSave.format = this._format;
            sessionToSave.recordingsDir = getRecordingsDir(this._settings);

            if (sessionToSave.tracks.length > 0) {
                loadRecordingSessions(this._settings).then(sessions => {
                    sessions.unshift(sessionToSave);
                    saveRecordingSessions(sessions, this._settings);
                }).catch(error => {
                    logError(error, 'Failed to persist recording session');
                });
            }
        }

        this._session = null;
        this._station = null;
        this._currentMetadata = null;
        this._currentTrack = null;
        this._lastTrackTitle = '';
        this._usedFilenames = new Set();
        this._trackRotatePending = false;
        this._recording = false;
        this._emit('onRecordingChanged', false);
    }

    onPlaybackStateChanged(state) {
        this._playbackState = state;

        if (!this._recording)
            return;

        if (state === 'stopped') {
            this.stop();
            return;
        }

        if (state === 'paused')
            this._playbackManager.setRecordingActive(false);
        else if (state === 'playing' && !this._trackRotatePending)
            this._playbackManager.setRecordingActive(true);
    }

    onStationChanged(station) {
        if (!this._recording || !this._station)
            return;

        if (!station) {
            this.stop();
            return;
        }

        if (this._station.uuid && station.uuid && this._station.uuid !== station.uuid) {
            this.stop();
            return;
        }

        if (this._station.url && station.url && this._station.url !== station.url)
            this.stop();
    }

    onMetadataUpdate(metadata) {
        if (!metadata)
            return;

        this._currentMetadata = metadata;

        if (!this._recording)
            return;

        this._handleTitleChange(metadata.title, metadata.artist);
    }

    _handleTitleChange(newTitle, artist) {
        if (!this._recording || this._trackRotatePending)
            return;

        const normalized = _normalizeTitle(newTitle);
        if (!normalized || normalized === this._lastTrackTitle)
            return;

        try {
            this._finalizeCurrentTrack();
            this._lastTrackTitle = normalized;
            this._startTrack({ title: newTitle, artist });
        } catch (error) {
            logError(error, 'Failed to start new recording track');
        }
    }

    _resumeRecordingAfterRotate(error) {
        this._trackRotatePending = false;

        if (error) {
            logError(error, 'Failed to rotate recording track');
            return;
        }

        if (this._recording && this._playbackState === 'playing')
            this._playbackManager.setRecordingActive(true);
    }

    _startTrack(metadata) {
        this._trackIndex += 1;
        const stationName = stationDisplayName(this._station);
        const rawTitle = String(metadata?.title ?? '').trim() || stationName || _('Unknown title');
        const rawArtist = String(metadata?.artist ?? '').trim() || '';
        const { basename, filename } = buildRecordingTrackFilename(
            rawArtist,
            rawTitle,
            stationName,
            this._format,
            this._usedFilenames
        );

        this._currentTrack = {
            id: generateRecordingTrackId(),
            index: this._trackIndex,
            title: basename,
            artist: rawArtist,
            filename,
            startedAt: Date.now(),
            endedAt: null,
            durationSeconds: 0,
        };

        this._session.tracks.push(this._currentTrack);
        this._lastTrackTitle = _normalizeTitle(rawTitle) || this._lastTrackTitle;

        ensureRecordingSessionDir(this._session.folderName, this._settings);
        const path = getRecordingSessionPath(filename, this._settings, this._session);
        const rotatingTrack = this._trackIndex > 1;

        if (rotatingTrack) {
            this._trackRotatePending = true;
            if (!this._playbackManager.rotateRecordingOutputPath(path, (error) => {
                this._resumeRecordingAfterRotate(error);
            }))
                throw new Error(_('Failed to rotate recording track'));
            return;
        }

        if (!this._playbackManager.setRecordingOutputPath(path))
            throw new Error(_('Failed to set recording output path'));

        this._playbackManager.setRecordingActive(this._playbackState === 'playing');
    }

    _finalizeCurrentTrack() {
        if (!this._currentTrack)
            return;

        this._currentTrack.endedAt = Date.now();
        const durationMs = this._currentTrack.endedAt - (this._currentTrack.startedAt || this._currentTrack.endedAt);
        this._currentTrack.durationSeconds = Math.max(0, Math.floor(durationMs / 1000));
        this._currentTrack = null;
    }

    destroy() {
        this.stop();
        this._listeners = {};
    }
}
