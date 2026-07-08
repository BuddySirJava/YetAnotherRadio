import Gst from 'gi://Gst';
import GstAudio from 'gi://GstAudio';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';

import { loadStations, saveStations, stationDisplayName } from '../radioUtils.js';
import { parseMetadataTags, queryPlayerTags } from './metadataDisplay.js';

const ShellVersion = parseFloat(Config.PACKAGE_VERSION);
const GST_PLAY_FLAG_BUFFERING = Gst.PlayFlags?.BUFFERING ?? (1 << 8);

function _isIgnorableLiveStreamError(errorMessage, debugInfo) {
    const text = `${errorMessage || ''} ${debugInfo || ''}`.toLowerCase();
    return text.includes('does not support seeking') ||
        text.includes('does not accept range') ||
        text.includes('range http');
}

export default class PlaybackManager {
    constructor(settings, callbacks, osdIcon = null) {
        this._settings = settings;
        this._callbacks = callbacks || {};
        this._listeners = {};
        this._osdIcon = osdIcon;

        this._player = null;
        this._bus = null;
        this._busHandlerId = null;

        this._audioSinkBin = null;
        this._audioTee = null;
        this._recordTeePad = null;
        this._recordQueue = null;
        this._recordValve = null;
        this._recordFilesink = null;
        this._recordEncoder = null;

        this._recordRotateTimeoutId = null;

        this._metadataTimer = null;
        this._playTimeTimer = null;

        this._nowPlaying = null;
        this._playbackState = 'stopped';
        this._pausedAt = null;
        this._playStartedAtMs = null;
        this._elapsedBeforePauseMs = 0;

        this._currentMetadata = {
            title: null,
            artist: null,
            albumArt: null,
            bitrate: null,
            nowPlaying: null,
            playbackState: 'stopped',
            playTimeSeconds: 0
        };
    }

    addListener(event, fn) {
        (this._listeners[event] ||= []).push(fn);
    }

    removeListener(event, fn) {
        const list = this._listeners[event];
        if (list) {
            const idx = list.indexOf(fn);
            if (idx !== -1) list.splice(idx, 1);
        }
    }

    _emit(event, ...args) {
        this._callbacks[event]?.(...args);
        (this._listeners[event] || []).forEach(fn => fn(...args));
    }

    _initGst() {
        if (!Gst.is_initialized()) {
            Gst.init([]);
        }
    }

    _waitForNullState() {
        if (!this._player)
            return;

        const [, state] = this._player.get_state(0);
        if (state === Gst.State.NULL)
            return;

        this._player.set_state(Gst.State.NULL);
    }

    get currentMetadata() {
        return this._currentMetadata;
    }

    get playbackState() {
        return this._playbackState;
    }

    get nowPlaying() {
        return this._nowPlaying;
    }

    getMPRISMetadata() {
        const metadata = {};

        if (this._currentMetadata.title) {
            metadata['xesam:title'] = new GLib.Variant('s', this._currentMetadata.title);
        }
        if (this._currentMetadata.artist) {
            metadata['xesam:artist'] = new GLib.Variant('as', [this._currentMetadata.artist]);
        }

        let artUrl = this._currentMetadata.albumArt || this._nowPlaying?.favicon || null;
        if (artUrl) {
            if (artUrl.startsWith('/')) {
                artUrl = 'file://' + artUrl;
            }
            metadata['mpris:artUrl'] = new GLib.Variant('s', artUrl);
        }

        return metadata;
    }

    _createAudioSinkBin() {
        const bin = Gst.Bin.new('audio-sink-bin');
        const tee = Gst.ElementFactory.make('tee', 'audio-tee');
        const playQueue = Gst.ElementFactory.make('queue', 'play-queue');
        const pulseSink = Gst.ElementFactory.make('pulsesink', 'pulse-sink');

        if (!tee || !playQueue || !pulseSink)
            throw new Error(_('GStreamer audio sink plugins missing'));

        pulseSink.set_property('buffer-time', 1000000);
        pulseSink.set_property('latency-time', 50000);

        bin.add(tee);
        bin.add(playQueue);
        bin.add(pulseSink);

        playQueue.link(pulseSink);

        const teePlayPad = tee.request_pad_simple('src_%u');
        if (teePlayPad.link(playQueue.get_static_pad('sink')) !== Gst.PadLinkReturn.OK)
            throw new Error(_('Failed to link playback branch'));

        const ghost = Gst.GhostPad.new('sink', tee.get_static_pad('sink'));
        bin.add_pad(ghost);

        this._audioSinkBin = bin;
        this._audioTee = tee;

        return bin;
    }

    _hasRecordingBranch() {
        return Boolean(this._recordFilesink);
    }

    _attachRecordingBranch(path) {
        if (this._hasRecordingBranch())
            return true;

        if (!this._audioSinkBin || !this._audioTee || !path)
            return false;

        const recordQueue = Gst.ElementFactory.make('queue', 'record-queue');
        const recordValve = Gst.ElementFactory.make('valve', 'record-valve');
        const recordEncoder = Gst.ElementFactory.make('lamemp3enc', 'record-encoder');
        const recordFilesink = Gst.ElementFactory.make('filesink', 'record-filesink');

        if (!recordQueue || !recordValve || !recordEncoder || !recordFilesink)
            throw new Error(_('GStreamer recording plugins missing'));

        recordQueue.set_property('max-size-time', 10 * Gst.SECOND);
        recordQueue.set_property('max-size-buffers', 0);
        recordQueue.set_property('max-size-bytes', 0);
        recordEncoder.set_property('target', 0);
        recordEncoder.set_property('quality', 0);
        recordValve.set_property('drop', true);
        recordFilesink.set_property('sync', false);
        recordFilesink.set_property('async', false);
        recordFilesink.set_property('location', path);

        this._audioSinkBin.add(recordQueue);
        this._audioSinkBin.add(recordValve);
        this._audioSinkBin.add(recordEncoder);
        this._audioSinkBin.add(recordFilesink);

        recordQueue.link(recordValve);
        recordValve.link(recordEncoder);
        recordEncoder.link(recordFilesink);

        const teeRecordPad = this._audioTee.request_pad_simple('src_%u');
        if (teeRecordPad.link(recordQueue.get_static_pad('sink')) !== Gst.PadLinkReturn.OK)
            throw new Error(_('Failed to link recording branch'));

        for (const element of [recordQueue, recordValve, recordEncoder, recordFilesink])
            element.sync_state_with_parent();

        this._recordTeePad = teeRecordPad;
        this._recordQueue = recordQueue;
        this._recordValve = recordValve;
        this._recordEncoder = recordEncoder;
        this._recordFilesink = recordFilesink;

        return true;
    }

    _detachRecordingBranch() {
        if (!this._hasRecordingBranch())
            return;

        if (this._recordValve)
            this._recordValve.set_property('drop', true);

        const elements = [
            this._recordFilesink,
            this._recordEncoder,
            this._recordValve,
            this._recordQueue,
        ].filter(Boolean);

        for (const element of elements)
            element.set_state(Gst.State.NULL);

        if (this._recordTeePad && this._audioTee)
            this._audioTee.release_request_pad(this._recordTeePad);

        for (const element of elements)
            this._audioSinkBin.remove(element);

        this._recordTeePad = null;
        this._recordQueue = null;
        this._recordValve = null;
        this._recordEncoder = null;
        this._recordFilesink = null;
    }

    setRecordingOutputPath(path) {
        if (!path)
            return false;

        if (!this._hasRecordingBranch())
            return this._attachRecordingBranch(path);

        this._recordFilesink.set_property('location', path);
        return true;
    }

    setRecordingActive(active) {
        if (!this._recordValve)
            return false;

        this._recordValve.set_property('drop', !active);
        return true;
    }

    rotateRecordingOutputPath(path, callback = null) {
        if (!this._recordValve || !this._recordFilesink || !path)
            return false;

        if (this._recordRotateTimeoutId) {
            GLib.source_remove(this._recordRotateTimeoutId);
            this._recordRotateTimeoutId = null;
        }

        this._recordValve.set_property('drop', true);

        this._recordRotateTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            this._recordRotateTimeoutId = null;

            if (!this._recordFilesink) {
                if (callback)
                    callback(new Error(_('Recording branch unavailable')));
                return GLib.SOURCE_REMOVE;
            }

            this._recordFilesink.set_state(Gst.State.NULL);
            this._recordFilesink.set_property('location', path);
            this._recordFilesink.sync_state_with_parent();
            if (callback)
                callback(null);

            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    stopRecordingBranch() {
        if (this._recordRotateTimeoutId) {
            GLib.source_remove(this._recordRotateTimeoutId);
            this._recordRotateTimeoutId = null;
        }

        this._detachRecordingBranch();
    }

    _ensurePlayer() {
        if (this._player) return;

        this._initGst();

        this._player = Gst.ElementFactory.make('playbin3', 'radio-player');
        if (!this._player) {
            throw new Error('GStreamer playbin3 plugin missing');
        }

        const volume = (this._settings.get_int('volume') ?? 100) / 100.0;
        this._player.set_volume(GstAudio.StreamVolumeFormat.CUBIC, volume);

        const fakeVideoSink = Gst.ElementFactory.make('fakesink', 'fake-video-sink');
        this._player.set_property('video-sink', fakeVideoSink);

        this._player.set_property('audio-sink', this._createAudioSinkBin());

        const flags = this._player.get_property('flags');
        this._player.set_property('flags', flags & ~GST_PLAY_FLAG_BUFFERING);

        this._bus = this._player.get_bus();
        this._bus.add_signal_watch();
        this._busHandlerId = this._bus.connect('message', (b, message) => this._handleBusMessage(message));
    }

    _applyMetadataUpdate(metadata) {
        if (!metadata)
            return;

        if (metadata.title)
            this._currentMetadata.title = metadata.title;
        if (metadata.artist)
            this._currentMetadata.artist = metadata.artist;
        if (metadata.albumArt)
            this._currentMetadata.albumArt = metadata.albumArt;
        if (metadata.bitrate)
            this._currentMetadata.bitrate = metadata.bitrate;

        this._emit('onMetadataUpdate');
    }

    _handleBusMessage(message) {
        if (message.type === Gst.MessageType.TAG) {
            const tagList = message.parse_tag();
            const metadata = parseMetadataTags(tagList);
            if (metadata)
                this._applyMetadataUpdate(metadata);
        } else if (message.type === Gst.MessageType.ERROR) {
            const [error, debug] = message.parse_error();
            let errorMessage = '';
            if (error) {
                if (error.message) errorMessage = String(error.message);
                else errorMessage = String(error);
            } else if (debug) {
                errorMessage = String(debug);
            }

            if (_isIgnorableLiveStreamError(errorMessage, debug)) {
                console.debug('Ignoring non-fatal live stream error:', errorMessage);
                return;
            }

            console.error(error, debug);

            let errorBody = _('Could not play the selected station.');
            if (errorMessage)
                errorBody = errorMessage;

            Main.notifyError(_('Playback error'), GLib.markup_escape_text(errorBody, -1));
            this.stop();

        } else if (message.type === Gst.MessageType.EOS) {
            this.stop();
        }
    }

    play(station) {
        try {
            this._ensurePlayer();

            this._currentMetadata.title = null;
            this._currentMetadata.artist = null;
            this._currentMetadata.albumArt = null;
            this._currentMetadata.bitrate = null;
            this._currentMetadata.playTimeSeconds = 0;

            this._waitForNullState();
            this._player.set_property('uri', station.url);

            const vol = (this._settings.get_int('volume') ?? 100) / 100;
            this._player.set_volume(GstAudio.StreamVolumeFormat.CUBIC, vol);

            this._player.set_state(Gst.State.PLAYING);

            this._updateStationHistory(station);

            this._nowPlaying = station;
            this._playbackState = 'playing';
            this._playStartedAtMs = Date.now();
            this._elapsedBeforePauseMs = 0;

            this._currentMetadata.nowPlaying = station;
            this._currentMetadata.playbackState = 'playing';

            this._emit('onStateChanged', 'playing');
            this._emit('onStationChanged', station);
            this._emit('onVisibilityChanged', true);

            this._startMetadataUpdate();
            this._startPlayTimeUpdate();
            
            this._showPlayingNotification(station);

        } catch (error) {
            console.error(error, 'Failed to start playback');
            const errorMsg = String(error);
            Main.notifyError(_('Playback error'), GLib.markup_escape_text(errorMsg, -1));
            this.stop();
        }
    }

    _showPlayingNotification(station) {
        if (!this._settings?.get_boolean('show-playing-notification'))
            return;

        const displayName = stationDisplayName(station);
        const escapedName = GLib.markup_escape_text(displayName, -1);
        const message = _('Playing %s').format(escapedName);

        const icon = this._osdIcon || Gio.ThemedIcon.new('media-playback-start-symbolic');

        if (Main.osdWindowManager) {
            if (ShellVersion >= 49 && Main.osdWindowManager.showAll) {
                Main.osdWindowManager.showAll(icon, message, null, null);
                return;
            }

            if (Main.osdWindowManager.show) {
                Main.osdWindowManager.show(-1, icon, message, null, null);
                return;
            }
        }

        Main.notify(message, '');
    }

    toggle() {
        if (!this._player) return;

        if (this._playbackState === 'playing') {
            this._player.set_state(Gst.State.PAUSED);
            this._playbackState = 'paused';
            this._pausedAt = Date.now();
            this._elapsedBeforePauseMs = this._getElapsedPlayMs();
            this._playStartedAtMs = null;

            this._currentMetadata.playbackState = 'paused';
            this._currentMetadata.playTimeSeconds = Math.floor(this._elapsedBeforePauseMs / 1000);
            this._emit('onStateChanged', 'paused');
            this._emit('onMetadataUpdate');

        } else if (this._playbackState === 'paused') {
            this._pausedAt = null;

            if (this._nowPlaying)
                this.play(this._nowPlaying);
        }
    }

    stop() {
        if (this._player)
            this._waitForNullState();

        this._nowPlaying = null;
        this._playbackState = 'stopped';
        this._pausedAt = null;
        this._playStartedAtMs = null;
        this._elapsedBeforePauseMs = 0;

        this._currentMetadata.nowPlaying = null;
        this._currentMetadata.playbackState = 'stopped';
        this._currentMetadata.title = null;
        this._currentMetadata.artist = null;
        this._currentMetadata.albumArt = null;
        this._currentMetadata.bitrate = null;
        this._currentMetadata.playTimeSeconds = 0;

        this._stopMetadataUpdate();
        this._stopPlayTimeUpdate();

        this._emit('onStateChanged', 'stopped');
        this._emit('onStationChanged', null);
        this._emit('onVisibilityChanged', false);
    }

    setVolume(volume) {
        if (this._player) {
            this._player.set_volume(GstAudio.StreamVolumeFormat.CUBIC, volume);
        }
    }

    _startMetadataUpdate() {
        this._stopMetadataUpdate();
        const interval = this._settings?.get_int('metadata-update-interval') ?? 2;
        this._metadataTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                queryPlayerTags(this._player, this._currentMetadata);
                this._emit('onMetadataUpdate');
                return true;
            }
        );
    }

    _stopMetadataUpdate() {
        if (this._metadataTimer) {
            GLib.source_remove(this._metadataTimer);
            this._metadataTimer = null;
        }
    }

    _getElapsedPlayMs() {
        if (this._playbackState === 'playing' && this._playStartedAtMs) {
            return this._elapsedBeforePauseMs + Math.max(0, Date.now() - this._playStartedAtMs);
        }

        return this._elapsedBeforePauseMs;
    }

    _startPlayTimeUpdate() {
        this._stopPlayTimeUpdate();
        this._playTimeTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            1,
            () => {
                if (this._playbackState !== 'playing')
                    return true;

                this._currentMetadata.playTimeSeconds = Math.floor(this._getElapsedPlayMs() / 1000);
                this._emit('onMetadataUpdate');
                return true;
            }
        );
    }

    _stopPlayTimeUpdate() {
        if (this._playTimeTimer) {
            GLib.source_remove(this._playTimeTimer);
            this._playTimeTimer = null;
        }
    }

    _updateStationHistory(station) {
        loadStations().then(stations => {
            const stationIndex = stations.findIndex(s => s.uuid === station.uuid);
            if (stationIndex >= 0) {
                stations[stationIndex].lastPlayed = Date.now();
                saveStations(stations);
            }
        }).catch(err => {
            console.error('Failed to update station history', err);
        });
    }

    destroy() {
        this.stopRecordingBranch();
        this.stop();

        if (this._metadataTimer) {
            GLib.source_remove(this._metadataTimer);
            this._metadataTimer = null;
        }

        if (this._playTimeTimer) {
            GLib.source_remove(this._playTimeTimer);
            this._playTimeTimer = null;
        }

        if (this._bus) {
            if (this._busHandlerId) {
                this._bus.disconnect(this._busHandlerId);
                this._busHandlerId = null;
            }
            this._bus.remove_signal_watch();
            this._bus = null;
        }

        if (this._player) {
            this._waitForNullState();
            this._player = null;
        }
    }
}
