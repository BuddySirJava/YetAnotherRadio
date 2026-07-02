import St from 'gi://St';
import Gio from 'gi://Gio';
import Gst from 'gi://Gst';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import { gettext as _ } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { createHoverScrollingLabel, createScrollGroup } from './hoverScrollingLabel.js';
import { formatDuration } from '../radioUtils.js';

const METADATA_ICON_SIZE = 64;
const COMBINED_TITLE_SEPARATORS = [' - ', ' – ', ' — '];

function _splitCombinedTrackTitle(title, artist) {
    const rawArtist = String(artist ?? '').trim();
    if (rawArtist) {
        const rawTitle = String(title ?? '').trim();
        return { title: rawTitle || null, artist: rawArtist };
    }

    const rawTitle = String(title ?? '').trim();
    if (!rawTitle)
        return { title: null, artist: null };

    for (const separator of COMBINED_TITLE_SEPARATORS) {
        const index = rawTitle.indexOf(separator);
        if (index <= 0)
            continue;

        const parsedArtist = rawTitle.slice(0, index).trim();
        const parsedTitle = rawTitle.slice(index + separator.length).trim();
        if (parsedArtist && parsedTitle)
            return { title: parsedTitle, artist: parsedArtist };
    }

    return { title: rawTitle, artist: null };
}

function _buildTrackText(currentMetadata) {
    const title = String(currentMetadata?.title ?? '').trim();
    const artist = String(currentMetadata?.artist ?? '').trim();

    if (artist && title)
        return `${artist} - ${title}`;

    return title || artist || '';
}

function _copyToClipboard(text) {
    const value = String(text ?? '').trim();
    if (!value)
        return;

    const preview = value.length > 80 ? `${value.slice(0, 77)}...` : value;
    try {
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, value);
        Main.notify(_('Copied to clipboard'), GLib.markup_escape_text(preview, -1));
    } catch (e) {
        logError(e, 'Failed to copy to clipboard');
        Main.notify(_('Track info'), GLib.markup_escape_text(preview, -1));
    }
}

export function createMetadataItem(playPauseCallback, stopCallback, recordCallback) {
    const box = new St.BoxLayout({
        vertical: false,
        style_class: 'metadata-item-box',
        y_align: Clutter.ActorAlign.CENTER
    });

    const thumbnail = new St.Icon({
        icon_name: 'audio-x-generic-symbolic',
        icon_size: METADATA_ICON_SIZE,
        style_class: 'metadata-thumbnail',
        reactive: true
    });
    box.add_child(thumbnail);

    const textBox = new St.BoxLayout({
        vertical: true,
        style_class: 'metadata-text-box',
        reactive: false
    });

    const scrollGroup = createScrollGroup();

    const titleScroll = createHoverScrollingLabel({
        styleClass: 'metadata-title',
        clipStyleClass: 'yetanotherradio-hover-scroll yetanotherradio-hover-scroll-title',
        xExpand: true,
        multiline: true,
        maxLines: 2,
        scrollGroup,
    });

    const copyTrackBtn = new St.Button({
        style_class: 'metadata-copy-button',
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Icon({
            icon_name: 'edit-copy-symbolic',
            style_class: 'metadata-overlay-icon'
        })
    });
    copyTrackBtn.connect('clicked', () => _copyToClipboard(copyTrackBtn._trackText));
    copyTrackBtn._trackText = '';
    // Keep button allocated in layout to prevent vertical/width jumps.
    copyTrackBtn.visible = true;
    copyTrackBtn.opacity = 0;
    copyTrackBtn.reactive = false;
    copyTrackBtn.sensitive = false;

    const titleRow = new St.BoxLayout({
        vertical: false,
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER
    });
    titleRow.add_child(titleScroll.actor);
    titleRow.add_child(copyTrackBtn);
    textBox.add_child(titleRow);

    const artistScroll = createHoverScrollingLabel({
        styleClass: 'metadata-artist',
        clipStyleClass: 'yetanotherradio-hover-scroll yetanotherradio-hover-scroll-artist',
        scrollGroup,
    });
    textBox.add_child(artistScroll.actor);

    const timeLabel = new St.Label({
        text: '00:00',
        style_class: 'metadata-time',
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false
    });

    const qualityLabel = new St.Label({
        text: '',
        style_class: 'metadata-quality',
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: false
    });

    const metaInfoBox = new St.BoxLayout({
        vertical: true,
        style_class: 'metadata-info-box',
        x_expand: false,
        y_align: Clutter.ActorAlign.CENTER
    });
    metaInfoBox.add_child(timeLabel);
    metaInfoBox.add_child(qualityLabel);

    const bottomRow = new St.BoxLayout({
        vertical: false,
        style_class: 'metadata-bottom-row',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER
    });

    bottomRow.add_child(metaInfoBox);

    const controlsBox = new St.BoxLayout({
        style_class: 'metadata-controls-box',
        vertical: false,
        x_align: Clutter.ActorAlign.END,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
    });

    const playbackControlsBox = new St.BoxLayout({
        style_class: 'button metadata-controls-pill',
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: true,
    });

    playbackControlsBox.connect('enter-event', () => Clutter.EVENT_PROPAGATE);
    playbackControlsBox.connect('leave-event', () => Clutter.EVENT_PROPAGATE);

    const playPauseBtn = new St.Button({
        style_class: 'icon-button metadata-overlay-button',
        child: new St.Icon({
            icon_name: 'media-playback-pause-symbolic',
            style_class: 'metadata-overlay-icon'
        })
    });
    playPauseBtn.connect('clicked', () => playPauseCallback?.());
    playbackControlsBox.add_child(playPauseBtn);

    const stopBtn = new St.Button({
        style_class: 'icon-button metadata-overlay-button',
        child: new St.Icon({
            icon_name: 'media-playback-stop-symbolic',
            style_class: 'metadata-overlay-icon'
        })
    });
    stopBtn.connect('clicked', () => stopCallback?.());
    playbackControlsBox.add_child(stopBtn);

    const recordControlsBox = new St.BoxLayout({
        style_class: 'button metadata-controls-pill',
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        reactive: true,
    });

    recordControlsBox.connect('enter-event', () => Clutter.EVENT_PROPAGATE);
    recordControlsBox.connect('leave-event', () => Clutter.EVENT_PROPAGATE);

    const recordBtn = new St.Button({
        style_class: 'icon-button metadata-overlay-button metadata-record-button',
        child: new St.Icon({
            icon_name: 'media-record-symbolic',
            style_class: 'metadata-overlay-icon'
        })
    });
    recordBtn.connect('clicked', () => recordCallback?.());
    recordControlsBox.add_child(recordBtn);

    controlsBox.add_child(playbackControlsBox);
    controlsBox.add_child(recordControlsBox);
    bottomRow.add_child(controlsBox);

    textBox.add_child(bottomRow);

    box.add_child(textBox);

    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        can_focus: true,
        style_class: 'yetanotherradio-metadata-item'
    });
    item.add_child(box);

    item._thumbnail = thumbnail;
    item._titleScroll = titleScroll;
    item._artistScroll = artistScroll;
    item._titleLabel = titleScroll.label;
    item._artistLabel = artistScroll.label;
    item._timeLabel = timeLabel;
    item._qualityLabel = qualityLabel;
    item._playPauseBtn = playPauseBtn;
    item._copyTrackBtn = copyTrackBtn;
    item._recordBtn = recordBtn;
    item._recordBlinkId = 0;

    // Defensive teardown: stop blink regardless of recording event flow.
    item.connect('destroy', () => {
        _stopRecordBlink(item);
    });

    return item;
}

export function updateCopyButton(metadataItem, currentMetadata) {
    if (!metadataItem?._copyTrackBtn)
        return;

    const track = _buildTrackText(currentMetadata);
    const hasTrack = Boolean(track);
    metadataItem._copyTrackBtn._trackText = track;
    metadataItem._copyTrackBtn.opacity = hasTrack ? 255 : 0;
    metadataItem._copyTrackBtn.reactive = hasTrack;
    metadataItem._copyTrackBtn.sensitive = hasTrack;
}

export function updatePlaybackStateIcon(item, playbackState) {
    if (!item || !item._playPauseBtn) return;
    const icon = item._playPauseBtn.child;
    if (playbackState === 'playing') {
        icon.icon_name = 'media-playback-pause-symbolic';
    } else {
        icon.icon_name = 'media-playback-start-symbolic';
    }
}

const RECORD_BLINK_INTERVAL_MS = 500;

function _stopRecordBlink(item) {
    if (item._recordBlinkId) {
        GLib.source_remove(item._recordBlinkId);
        item._recordBlinkId = 0;
    }

    const icon = item._recordBtn?.child;
    if (icon)
        icon.opacity = 255;
}

function _startRecordBlink(item) {
    _stopRecordBlink(item);

    const icon = item._recordBtn.child;
    let bright = true;

    item._recordBlinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECORD_BLINK_INTERVAL_MS, () => {
        bright = !bright;
        icon.opacity = bright ? 255 : 90;
        return GLib.SOURCE_CONTINUE;
    });
}

export function updateRecordingState(item, isRecording) {
    if (!item?._recordBtn)
        return;

    if (isRecording) {
        item._recordBtn.add_style_class_name('metadata-record-button-active');
        _startRecordBlink(item);
    } else {
        item._recordBtn.remove_style_class_name('metadata-record-button-active');
        _stopRecordBlink(item);
    }
}

function extractImageFromSample(sample) {
    if (!sample)
        return null;

    try {
        const buffer = sample.get_buffer();
        if (!buffer) {
            console.debug('extractImageFromSample: No buffer');
            return null;
        }

        const mapInfo = buffer.map(Gst.MapFlags.READ);
        if (!mapInfo) {
            console.debug('extractImageFromSample: Could not map buffer');
            return null;
        }

        try {
            const data = mapInfo.data;
            if (!data || data.length === 0) {
                console.debug('extractImageFromSample: Empty data');
                return null;
            }

            let extension = 'jpg';
            const caps = sample.get_caps();
            if (caps) {
                const structure = caps.get_structure(0);
                if (structure) {
                    const name = structure.get_name();
                    if (name) {
                        if (name.includes('png')) extension = 'png';
                        else if (name.includes('gif')) extension = 'gif';
                        else if (name.includes('jpeg') || name.includes('jpg')) extension = 'jpg';
                        else if (name.includes('webp')) extension = 'webp';
                    }
                }
            }

            const tmpDir = GLib.get_tmp_dir();
            const tmpFile = Gio.File.new_for_path(
                GLib.build_filenamev([tmpDir, `yetanotherradio-art-${GLib.get_real_time()}.${extension}`])
            );

            const outputStream = tmpFile.replace(null, false, Gio.FileCreateFlags.NONE, null);
            outputStream.write_all(data, null);
            outputStream.close(null);

            return tmpFile.get_uri();
        } catch (e) {
            console.debug('Error writing image data:', e);
            return null;
        } finally {
            buffer.unmap(mapInfo);
        }
    } catch (e) {
        console.debug('Error extracting image from sample:', e);
        return null;
    }
}

export function parseMetadataTags(tagList) {
    if (!tagList)
        return null;

    let title = null;
    if (tagList.get_string(Gst.TAG_TITLE)) {
        [, title] = tagList.get_string(Gst.TAG_TITLE);
    }

    let artist = null;
    if (tagList.get_string(Gst.TAG_ARTIST)) {
        [, artist] = tagList.get_string(Gst.TAG_ARTIST);
    }

    ({ title, artist } = _splitCombinedTrackTitle(title, artist));

    let albumArt = null;
    let sample;
    if (tagList.get_sample(Gst.TAG_IMAGE)) {
        [, sample] = tagList.get_sample(Gst.TAG_IMAGE);
        albumArt = extractImageFromSample(sample);
    } else if (tagList.get_sample(Gst.TAG_PREVIEW_IMAGE)) {
        [, sample] = tagList.get_sample(Gst.TAG_PREVIEW_IMAGE);
        albumArt = extractImageFromSample(sample);
    }

    let bitrate = null;
    if (tagList.get_uint(Gst.TAG_BITRATE)) {
        [, bitrate] = tagList.get_uint(Gst.TAG_BITRATE);
    }

    return { title, artist, albumArt, bitrate };
}

export function queryPlayerTags(player, currentMetadata) {
    if (!player)
        return;

    try {
        const tagList = player.query_tags(Gst.TagMergeMode.UNDEFINED);
        const metadata = parseMetadataTags(tagList);
        if (metadata) {
            if (metadata.title) currentMetadata.title = metadata.title;
            if (metadata.artist) currentMetadata.artist = metadata.artist;
            if (metadata.albumArt) currentMetadata.albumArt = metadata.albumArt;
            if (metadata.bitrate) currentMetadata.bitrate = metadata.bitrate;
        }
    } catch (e) {
        console.debug(e);
    }
}

export function updateMetadataDisplay(settings, metadataItem, nowPlaying, currentMetadata) {
    if (!metadataItem.visible)
        return;

    const rawTitle = String(currentMetadata?.title ?? '').trim();
    const rawArtist = String(currentMetadata?.artist ?? '').trim();

    let title = rawTitle || _('Unknown title');
    const stationName = String(nowPlaying?.name ?? nowPlaying?.url ?? '').trim();
    let artist = rawArtist || stationName || _('Unknown artist');
    const bitrate = currentMetadata.bitrate;
    const playTime = formatDuration(currentMetadata?.playTimeSeconds);

    metadataItem._titleScroll.setText(title);
    metadataItem._artistScroll.setText(artist);
    metadataItem._artistScroll.actor.visible = true;
    metadataItem._timeLabel.text = playTime;

    if (bitrate) {
        const kbps = Math.round(bitrate / 1000);
        metadataItem._qualityLabel.text = `${kbps} kbps`;
        metadataItem._qualityLabel.visible = true;
    } else {
        metadataItem._qualityLabel.text = '';
        metadataItem._qualityLabel.visible = false;
    }

    let thumbnailSet = false;
    if (currentMetadata.albumArt) {
        try {
            let file;
            if (currentMetadata.albumArt.startsWith('file://') ||
                currentMetadata.albumArt.startsWith('http://') ||
                currentMetadata.albumArt.startsWith('https://')) {
                file = Gio.File.new_for_uri(currentMetadata.albumArt);
            } else if (currentMetadata.albumArt.startsWith('/')) {
                file = Gio.File.new_for_path(currentMetadata.albumArt);
            } else {
                file = Gio.File.new_for_uri(currentMetadata.albumArt);
            }
            const icon = new Gio.FileIcon({ file: file });
            metadataItem._thumbnail.gicon = icon;
            metadataItem._thumbnail.icon_size = METADATA_ICON_SIZE;
            metadataItem._thumbnail.icon_name = null;
            thumbnailSet = true;
        } catch (e) {
            console.debug(e);
        }
    }

    if (!thumbnailSet && nowPlaying?.favicon) {
        try {
            const file = Gio.File.new_for_uri(nowPlaying.favicon);
            const icon = new Gio.FileIcon({ file: file });
            metadataItem._thumbnail.gicon = icon;
            metadataItem._thumbnail.icon_size = METADATA_ICON_SIZE;
            metadataItem._thumbnail.icon_name = null;
            thumbnailSet = true;
        } catch (e) {
            console.debug(e);
        }
    }

    if (!thumbnailSet) {
        metadataItem._thumbnail.gicon = null;
        metadataItem._thumbnail.icon_name = 'audio-x-generic-symbolic';
    }
}

export function loadStationIcon(item, faviconUrl) {
    if (!faviconUrl)
        return;

    if (faviconUrl.startsWith('file://')) {
        const path = faviconUrl.replace('file://', '');
        if (!GLib.file_test(path, GLib.FileTest.EXISTS)) {
            return;
        }
    } else if (faviconUrl.startsWith('/')) {
        if (!GLib.file_test(faviconUrl, GLib.FileTest.EXISTS)) {
            return;
        }
    }

    try {
        const file = Gio.File.new_for_uri(faviconUrl);
        const icon = new Gio.FileIcon({ file: file });
        const iconWidget = new St.Icon({
            gicon: icon,
            icon_size: 16,
            style_class: 'system-status-icon'
        });
        item.insert_child_at_index(iconWidget, 0);
    } catch (e) {
        console.debug(e);
    }
}
