import GLib from 'gi://GLib';
import St from 'gi://St';
import Gio from 'gi://Gio';
import Clutter from 'gi://Clutter';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { stationDisplayName } from '../radioUtils.js';
import { createHoverScrollingLabel } from './hoverScrollingLabel.js';

export function createStationMenuItem(station, playStationCallback, isNowPlaying = false) {
    const stationName = stationDisplayName(station);

    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: true,
        can_focus: true,
    });

    item.connect('activate', () => {
        playStationCallback(station);
    });

    const box = new St.BoxLayout({
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: 'yetanotherradio-station-row',
    });

    const iconWidget = new St.Icon({
        icon_name: 'audio-x-generic-symbolic',
        icon_size: 16,
        style_class: 'system-status-icon',
    });
    box.add_child(iconWidget);

    const nameScroll = createHoverScrollingLabel({
        styleClass: 'yetanotherradio-station-label',
        clipStyleClass: 'yetanotherradio-hover-scroll yetanotherradio-hover-scroll-station',
        xExpand: true,
    });
    nameScroll.setText(stationName);
    nameScroll.setOpacity(isNowPlaying ? 140 : 255);
    box.add_child(nameScroll.actor);

    item.add_child(box);

    if (station.favicon) {
        let valid = false;
        if (station.favicon.startsWith('file://')) {
            const path = station.favicon.replace('file://', '');
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) valid = true;
        } else if (station.favicon.startsWith('/')) {
            if (GLib.file_test(station.favicon, GLib.FileTest.EXISTS)) valid = true;
        } else {
            valid = true;
        }

        if (valid) {
            try {
                const file = Gio.File.new_for_uri(station.favicon);
                const icon = new Gio.FileIcon({ file: file });
                iconWidget.gicon = icon;
                iconWidget.icon_name = null;
            } catch (e) {
                console.debug(e);
            }
        }
    }

    if (isNowPlaying) {
        item.actor.add_style_class_name('yetanotherradio-current-station');
    }

    return item;
}
