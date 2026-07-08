import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { Extension, gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { ensureStorageFile, loadStations, STORAGE_PATH, initTranslations } from './radioUtils.js';
import { createMetadataItem, updateCopyButton, updateMetadataDisplay, updatePlaybackStateIcon, updateRecordingState } from './modules/metadataDisplay.js';
import { createVolumeItem, onVolumeChanged } from './modules/volumeControl.js';
import { createStationMenuItem } from './modules/stationMenu.js';
import PlaybackManager from './modules/playbackManager.js';
import RecordingManager from './modules/recordingManager.js';
import MprisInterface from './modules/mprisInterface.js';

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init(stations, openPrefs, extensionPath, settings, onStationsChanged) {
            super._init(0.0, _('Yet Another Radio'));

            this._stations = stations ?? [];
            this._openPrefs = openPrefs;
            this._settings = settings;
            this._onStationsChanged = onStationsChanged;
            this._refreshIdleId = 0;

            const iconPath = `${extensionPath}/icons/yetanotherradio.svg`;
            const playingIconPath = `${extensionPath}/icons/playing.svg`;
            this._defaultIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(iconPath) });
            this._playingIcon = new Gio.FileIcon({ file: Gio.File.new_for_path(playingIconPath) });

            this._playbackManager = new PlaybackManager(this._settings, {
                onStateChanged: (state) => this._onStateChanged(state),
                onStationChanged: (station) => this._onStationChanged(station),
                onMetadataUpdate: () => this._updateMetadataDisplay(),
                onVisibilityChanged: (visible) => this._updateVisibility(visible)
            }, this._defaultIcon);

            this._recordingManager = new RecordingManager(this._settings, this._playbackManager);

            this._panelIcon = new St.Icon({
                gicon: this._defaultIcon,
                style_class: 'system-status-icon',
            });
            this.add_child(this._panelIcon);


            // Middle click: pause/resume current playback, or resume last station when stopped.
            this.connect('captured-event', (_actor, event) => {
                const type = event.type();
                const isButtonEvent = type === Clutter.EventType.BUTTON_PRESS || type === Clutter.EventType.BUTTON_RELEASE;
                if (!isButtonEvent || event.get_button() !== 2)
                    return Clutter.EVENT_PROPAGATE;

                // Block PanelMenu's default middle-click handling.
                if (type === Clutter.EventType.BUTTON_PRESS)
                    return Clutter.EVENT_STOP;

                const state = this._playbackManager.playbackState;
                if (state === 'playing' || state === 'paused') {
                    this._togglePlayback();
                } else {
                    const station = this._getLastPlayedStation();
                    if (station)
                        this._playStation(station);
                    else
                        Main.notify(_('Yet Another Radio'), _('No station played yet.'));
                }

                this.menu.close();
                return Clutter.EVENT_STOP;
            });

            this._metadataItem = createMetadataItem(
                () => this._togglePlayback(),
                () => this._stopPlayback(),
                () => this._toggleRecording()
            );
            this._metadataItem.visible = false;
            this.menu.addMenuItem(this._metadataItem);

            this._onRecordingChanged = (active) => {
                updateRecordingState(this._metadataItem, active);
            };
            this._recordingManager.addListener('onRecordingChanged', this._onRecordingChanged);

            this._volumeItem = createVolumeItem(this._settings);
            this._volumeItem._volumeSlider.connect('notify::value', () => this._onVolumeChanged());
            this._volumeItem.visible = false;
            this.menu.addMenuItem(this._volumeItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            if (PopupMenu.PopupMenuScrollSection) {
                this._stationSection = new PopupMenu.PopupMenuScrollSection();
                this._stationSection.actor.add_style_class_name('yetanotherradio-scroll-view');
                this.menu.addMenuItem(this._stationSection);
            } else {
                this._stationSection = new PopupMenu.PopupMenuSection();
                const scrollWrapper = new PopupMenu.PopupMenuSection();

                this._stationScrollView = new St.ScrollView({
                    style_class: 'yetanotherradio-scroll-view',
                    hscrollbar_policy: St.PolicyType.NEVER,
                    vscrollbar_policy: St.PolicyType.AUTOMATIC,
                    overlay_scrollbars: true,
                });
                this._stationScrollView.set_x_expand(true);
                this._stationScrollView.set_y_expand(true);
                this._stationScrollView.set_child(this._stationSection.actor);

                scrollWrapper.actor.add_child(this._stationScrollView);
                this.menu.addMenuItem(scrollWrapper);
            }

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            this._prefsItem = new PopupMenu.PopupMenuItem(_('Open preferences'));
            this._prefsItem.connect('activate', () => this._openPrefs());
            this.menu.addMenuItem(this._prefsItem);

            this._hintItem = new PopupMenu.PopupMenuItem(_('Use preferences to add stations.'));
            this._hintItem.reactive = false;
            this._hintItem.sensitive = false;
            this.menu.addMenuItem(this._hintItem);

            this._refreshStationsMenu();
        }

        _onStateChanged(state) {
            updatePlaybackStateIcon(this._metadataItem, state);
            this._recordingManager.onPlaybackStateChanged(state);

            if (!this._panelIcon)
                return;

            this._panelIcon.gicon = state === 'playing'
                ? this._playingIcon
                : this._defaultIcon;
        }

        _onStationChanged(station) {
            this._recordingManager.onStationChanged(station);

            if (this._refreshIdleId)
                return;

            this._refreshIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._refreshIdleId = 0;

                if (!this.menu)
                    return GLib.SOURCE_REMOVE;

                this._refreshStationsMenu();
                return GLib.SOURCE_REMOVE;
            });
        }

        _updateVisibility(visible) {
            this._metadataItem.visible = visible;
            this._volumeItem.visible = visible;

            if (!visible)
                updateCopyButton(this._metadataItem, null);
        }

        _onVolumeChanged() {
            onVolumeChanged(this._volumeItem._volumeSlider, this._volumeItem._volumeIcon, this._settings);
            this._playbackManager.setVolume(this._volumeItem._volumeSlider.value);
        }

        _updateMetadataDisplay() {
            this._recordingManager.onMetadataUpdate(this._playbackManager.currentMetadata);

            updateMetadataDisplay(
                this._settings,
                this._metadataItem,
                this._playbackManager.nowPlaying,
                this._playbackManager.currentMetadata
            );

            updateCopyButton(this._metadataItem, this._playbackManager.currentMetadata);
        }

        setStations(stations) {
            this._stations = stations ?? [];
            this._refreshStationsMenu();
            this._onStationsChanged(this._stations.length);
        }

        _refreshStationsMenu() {
            if (this._stationSection?.removeAll)
                this._stationSection.removeAll();

            if (!this._stations || !this._stations.length) {
                this._hintItem.visible = true;
                return;
            }

            this._hintItem.visible = false;

            const favorites = this._stations.filter(s => s.favorite).sort((a, b) =>
                (a.name || a.url).localeCompare(b.name || b.url)
            );
            const regular = this._stations.filter(s => !s.favorite);

            const isNowPlayingStation = (station) => {
                if (!this._playbackManager.nowPlaying) return false;
                if (this._playbackManager.nowPlaying.uuid && station.uuid)
                    return station.uuid === this._playbackManager.nowPlaying.uuid;
                return (station.name || station.url) === (this._playbackManager.nowPlaying.name || this._playbackManager.nowPlaying.url);
            };

            const addStation = (station) => {
                const item = this._createStationMenuItem(station, isNowPlayingStation(station));
                this._stationSection.addMenuItem(item);
            };

            favorites.forEach(addStation);
            if (favorites.length > 0 && regular.length > 0)
                this._stationSection.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            regular.forEach(addStation);
        }

        _createStationMenuItem(station, isNowPlaying = false) {
            return createStationMenuItem(station, (s) => this._playStation(s), isNowPlaying);
        }

        _playStation(station) {
            this._playbackManager.play(station);
        }

        _togglePlayback() {
            this._playbackManager.toggle();
        }

        _stopPlayback() {
            this._playbackManager.stop();
        }

        _toggleRecording() {
            this._recordingManager.toggle(
                this._playbackManager.nowPlaying,
                this._playbackManager.currentMetadata,
                this._playbackManager.playbackState
            );
        }

        _orderedStations() {
            const favorites = this._stations
                .filter(s => s.favorite)
                .sort((a, b) => a.name.localeCompare(b.name));
            const regulars = this._stations.filter(s => !s.favorite);
            return [...favorites, ...regulars];
        }

        _getLastPlayedStation() {
            if (!this._stations?.length)
                return null;

            const byLastPlayed = this._stations
                .slice()
                .filter(s => (s.lastPlayed ?? 0) > 0)
                .sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0));

            return byLastPlayed[0] ?? this._stations[0] ?? null;
        }

        navigateStation(delta) {
            if (!this._playbackManager.nowPlaying) return;
            const ordered = this._orderedStations();
            if (ordered.length <= 1) return;
            const currentIdx = ordered.findIndex(
                s => s.uuid === this._playbackManager.nowPlaying.uuid
            );
            if (currentIdx === -1) return;
            const nextIdx = (currentIdx + delta + ordered.length) % ordered.length;
            this._playStation(ordered[nextIdx]);
        }

        destroy() {
            this._recordingManager.removeListener('onRecordingChanged', this._onRecordingChanged);

            if (this._metadataItem)
                this._metadataItem.destroy();

            this._recordingManager.destroy();
            this._playbackManager.destroy();

            if (this._refreshIdleId) {
                GLib.source_remove(this._refreshIdleId);
                this._refreshIdleId = 0;
            }

            this._stationSection = null;
            this._stationScrollView = null;

            this._metadataItem = null;
            this._volumeItem = null;
            this._panelIcon = null;
            this._defaultIcon = null;
            this._playingIcon = null;
            this._prefsItem = null;
            this._hintItem = null;

            super.destroy();
        }
    });

export default class YetAnotherRadioExtension extends Extension {
    enable() {
        initTranslations(_);
        ensureStorageFile();
        this._settings = this.getSettings();
        this._indicator = new Indicator(
            [],
            () => {
                this.openPreferences().catch(error => {
                    logError(error, 'Failed to open preferences');
                    Main.notifyError(
                        _('Yet Another Radio'),
                        GLib.markup_escape_text(_('Could not open preferences.'), -1)
                    );
                });
            },
            this.path,
            this._settings,
            (count) => {
                if (this._mpris)
                    this._mpris.setStationCount(count);
            }
        );

        if (this._settings.get_boolean('enable-mpris')) {
            try {
                this._mpris = new MprisInterface(
                    this._indicator._playbackManager,
                    this._settings,
                    (delta) => this._indicator.navigateStation(delta),
                    () => this._indicator._stations.slice().sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))[0] ?? null,
                    () => this._indicator.menu.open(true)
                );
                this._mpris.setStationCount(this._indicator._stations.length);
            } catch (error) {
                console.warn('Failed to initialize MPRIS interface:', error);
            }
        }

        this._mprisSettingId = 0;
        this._mprisSettingId = this._settings.connect('changed::enable-mpris', () => {
            if (this._settings.get_boolean('enable-mpris')) {
                if (!this._mpris) {
                    try {
                        this._mpris = new MprisInterface(
                            this._indicator._playbackManager,
                            this._settings,
                            (delta) => this._indicator.navigateStation(delta),
                            () => this._indicator._stations.slice().sort((a, b) => (b.lastPlayed ?? 0) - (a.lastPlayed ?? 0))[0] ?? null,
                            () => this._indicator.menu.open(true)
                        );
                        this._mpris.setStationCount(this._indicator._stations.length);
                    } catch (error) {
                        console.warn('Failed to initialize MPRIS interface:', error);
                    }
                }
            } else {
                if (this._mpris) {
                    this._mpris.destroy();
                    this._mpris = null;
                }
            }
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);

        loadStations().then(stations => {
            if (this._indicator) {
                this._indicator.setStations(stations);
            }
        }).catch(error => {
            console.error('Failed to load stations:', error);
        });

        this._monitor = this._watchStationsFile();
    }

    _watchStationsFile() {
        const file = Gio.File.new_for_path(STORAGE_PATH);
        const monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitorHandlerId = monitor.connect('changed', () => {
            loadStations().then(stations => {
                this._indicator?.setStations(stations);
            }).catch(error => {
                console.error('Failed to reload stations:', error);
            });
        });
        return monitor;
    }

    disable() {
	// unlock-dialog is used for radio be able to continue playing while the screen is locked.
        if (this._monitor) {
            if (this._monitorHandlerId) {
                this._monitor.disconnect(this._monitorHandlerId);
                this._monitorHandlerId = null;
            }
            this._monitor.cancel();
            this._monitor = null;
        }

        if (this._mprisSettingId) {
            this._settings.disconnect(this._mprisSettingId);
            this._mprisSettingId = 0;
        }

        if (this._mpris) {
            this._mpris.destroy();
            this._mpris = null;
        }

        this._indicator?.destroy();
        this._indicator = null;

        this._settings = null;
    }
}
