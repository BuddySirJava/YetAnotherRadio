import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

const SCROLL_SPEED = 0.04;
const SCROLL_GAP = '     ';
const HOVER_LEAVE_DELAY_MS = 120;

function _setClutterText(label, props) {
    const t = label.clutter_text;
    if (!t)
        return;

    for (const [key, value] of Object.entries(props)) {
        const setter = t[`set_${key}`];
        if (setter)
            setter.call(t, value);
        else
            t[key] = value;
    }
}

function _configureIdle(label, { multiline, maxLines }) {
    if (multiline) {
        _setClutterText(label, {
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.END,
            max_lines: maxLines,
        });
    } else {
        _setClutterText(label, {
            line_wrap: false,
            ellipsize: Pango.EllipsizeMode.END,
        });
    }
}

function _configureScroll(label) {
    _setClutterText(label, {
        line_wrap: false,
        ellipsize: Pango.EllipsizeMode.NONE,
        max_lines: 0,
    });
}

export function createScrollGroup() {
    const members = new Set();

    return {
        add(member) {
            members.add(member);
        },

        onEnter(active) {
            for (const member of members) {
                if (member !== active)
                    member.stopFromGroup();
            }
        },
    };
}

export function createHoverScrollingLabel(params = {}) {
    const {
        styleClass = '',
        clipStyleClass = 'yetanotherradio-hover-scroll',
        xExpand = false,
        multiline = false,
        maxLines = 1,
        scrollGroup = null,
    } = params;

    let _text = '';
    let _overflows = false;
    let _scrolling = false;
    let _hovered = false;
    let _leaveTimeoutId = 0;
    let _overflowIdleId = 0;
    let _scrollIdleId = 0;
    let _adjustmentChangedId = 0;
    let _transition = null;
    const _signalIds = [];

    const scrollView = new St.ScrollView({
        style_class: clipStyleClass,
        hscrollbar_policy: St.PolicyType.NEVER,
        vscrollbar_policy: St.PolicyType.NEVER,
        clip_to_allocation: true,
        reactive: true,
        track_hover: true,
        x_expand: xExpand,
        y_expand: false,
    });

    const innerBox = new St.BoxLayout({
        x_expand: true,
        y_expand: false,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const label = new St.Label({
        text: '',
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.START,
        y_expand: false,
    });

    innerBox.add_child(label);
    scrollView.add_child(innerBox);

    const groupMember = {
        actor: scrollView,
        stopFromGroup: null,
    };

    if (scrollGroup)
        scrollGroup.add(groupMember);

    function _connect(actor, signal, handler) {
        _signalIds.push(actor.connect(signal, handler));
    }

    function _clipWidth() {
        return scrollView.width;
    }

    function _measureSingleLineWidth(text) {
        _configureScroll(label);
        label.text = text;
        const [, naturalWidth] = label.get_preferred_width(-1);
        _configureIdle(label, { multiline, maxLines });
        label.text = _text;
        return naturalWidth;
    }

    function _computeOverflow() {
        _overflowIdleId = 0;

        if (!_text) {
            _overflows = false;
            return false;
        }

        const layout = label.clutter_text.get_layout();
        if (layout.is_ellipsized()) {
            _overflows = true;
            return true;
        }

        const clipWidth = _clipWidth();
        if (clipWidth <= 0)
            return false;

        if (multiline) {
            _overflows = _measureSingleLineWidth(_text) > clipWidth;
            return _overflows;
        }

        const [, naturalWidth] = label.get_preferred_width(-1);
        _overflows = naturalWidth > clipWidth;
        return _overflows;
    }

    function _scheduleOverflowCheck() {
        if (_overflowIdleId)
            GLib.Source.remove(_overflowIdleId);

        _overflowIdleId = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            _overflowIdleId = 0;
            if (!_computeOverflow() && _clipWidth() <= 0)
                _scheduleOverflowCheck();
            return GLib.SOURCE_REMOVE;
        });
    }

    function _removeScrollTransition() {
        const adjustment = scrollView.get_hadjustment();
        if (!adjustment) {
            _transition = null;
            _adjustmentChangedId = 0;
            return;
        }

        if (_transition) {
            adjustment.remove_transition('scroll');
            _transition = null;
        }
        if (_adjustmentChangedId) {
            adjustment.disconnect(_adjustmentChangedId);
            _adjustmentChangedId = 0;
        }
        adjustment.value = 0;
    }

    function _stopScrolling() {
        if (_scrollIdleId) {
            GLib.Source.remove(_scrollIdleId);
            _scrollIdleId = 0;
        }

        _removeScrollTransition();
        _scrolling = false;

        label.text = _text;
        _configureIdle(label, { multiline, maxLines });
    }

    function _beginScrollAnimation(adjustment, segmentWidth) {
        if (!_hovered || _transition)
            return;

        const pageSize = adjustment.page_size ?? adjustment.pageSize;
        if (segmentWidth <= 0 || adjustment.upper <= pageSize)
            return;

        const initial = new GObject.Value();
        initial.init(GObject.TYPE_INT);
        initial.set_int(0);

        const final = new GObject.Value();
        final.init(GObject.TYPE_INT);
        final.set_int(segmentWidth);

        const pspec = adjustment.find_property('value');
        const interval = new Clutter.Interval({
            valueType: pspec.value_type,
            initial,
            final,
        });

        _transition = new Clutter.PropertyTransition({
            propertyName: 'value',
            progressMode: Clutter.AnimationMode.LINEAR,
            autoReverse: false,
            repeatCount: -1,
            duration: segmentWidth / SCROLL_SPEED,
            interval,
        });

        adjustment.value = 0;
        adjustment.add_transition('scroll', _transition);

        if (_adjustmentChangedId) {
            adjustment.disconnect(_adjustmentChangedId);
            _adjustmentChangedId = 0;
        }
    }

    function _tryBeginScrollAnimation(adjustment, segmentWidth) {
        if (!adjustment)
            return;

        const pageSize = adjustment.page_size ?? adjustment.pageSize;
        if (adjustment.upper > pageSize)
            _beginScrollAnimation(adjustment, segmentWidth);
    }

    function _startScrolling() {
        if (_scrolling || !_text || !_overflows || !_hovered)
            return;

        const clipWidth = _clipWidth();
        if (clipWidth <= 0)
            return;

        _configureScroll(label);

        label.text = _text;
        const [, textWidth] = label.get_preferred_width(-1);
        if (textWidth <= clipWidth) {
            _stopScrolling();
            return;
        }

        const segmentText = `${_text}${SCROLL_GAP}`;
        label.text = segmentText;
        const [, segmentWidth] = label.get_preferred_width(-1);

        _scrolling = true;

        const adjustment = scrollView.get_hadjustment();
        if (!adjustment) {
            _scrolling = false;
            return;
        }

        _removeScrollTransition();

        label.text = `${segmentText}${_text}`;

        _adjustmentChangedId = adjustment.connect('changed', () => {
            if (!_scrolling || _transition)
                return;

            _tryBeginScrollAnimation(adjustment, segmentWidth);
        });

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (!_scrolling || _transition)
                return GLib.SOURCE_REMOVE;

            _tryBeginScrollAnimation(adjustment, segmentWidth);
            return GLib.SOURCE_REMOVE;
        });
    }

    function _scheduleStart() {
        if (_scrollIdleId)
            GLib.Source.remove(_scrollIdleId);

        _scrollIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            _scrollIdleId = 0;
            if (!_hovered || _scrolling)
                return GLib.SOURCE_REMOVE;

            if (!_computeOverflow() && _clipWidth() <= 0) {
                _scheduleStart();
                return GLib.SOURCE_REMOVE;
            }

            if (_overflows)
                _startScrolling();

            return GLib.SOURCE_REMOVE;
        });
    }

    function _onHoverChanged() {
        if (scrollView.hover) {
            if (_leaveTimeoutId) {
                GLib.Source.remove(_leaveTimeoutId);
                _leaveTimeoutId = 0;
            }

            _hovered = true;
            if (scrollGroup)
                scrollGroup.onEnter(groupMember);

            if (!_scrolling)
                _scheduleStart();
            return;
        }

        _hovered = false;

        if (_leaveTimeoutId)
            GLib.Source.remove(_leaveTimeoutId);

        _leaveTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HOVER_LEAVE_DELAY_MS, () => {
            _leaveTimeoutId = 0;
            if (_hovered || scrollView.hover)
                return GLib.SOURCE_REMOVE;

            _stopScrolling();
            return GLib.SOURCE_REMOVE;
        });
    }

    groupMember.stopFromGroup = () => {
        _hovered = false;
        if (_leaveTimeoutId) {
            GLib.Source.remove(_leaveTimeoutId);
            _leaveTimeoutId = 0;
        }
        _stopScrolling();
    };

    function setText(text) {
        const newText = String(text ?? '');
        if (newText === _text)
            return;

        const wasHovered = _hovered || scrollView.hover;
        _stopScrolling();
        _text = newText;
        label.text = _text;
        _configureIdle(label, { multiline, maxLines });
        _scheduleOverflowCheck();

        if (wasHovered) {
            _hovered = true;
            _scheduleStart();
        }
    }

    function setOpacity(opacity) {
        label.opacity = opacity;
    }

    function destroy() {
        if (_leaveTimeoutId) {
            GLib.Source.remove(_leaveTimeoutId);
            _leaveTimeoutId = 0;
        }
        if (_overflowIdleId) {
            GLib.Source.remove(_overflowIdleId);
            _overflowIdleId = 0;
        }
        if (_scrollIdleId) {
            GLib.Source.remove(_scrollIdleId);
            _scrollIdleId = 0;
        }

        _removeScrollTransition();
        _scrolling = false;

        for (const id of _signalIds)
            scrollView.disconnect(id);
        _signalIds.length = 0;
    }

    _configureIdle(label, { multiline, maxLines });

    _connect(scrollView, 'notify::hover', _onHoverChanged);
    _connect(scrollView, 'scroll-event', () => Clutter.EVENT_PROPAGATE);
    _connect(scrollView, 'destroy', destroy);

    return {
        actor: scrollView,
        label,
        setText,
        setOpacity,
        destroy,
    };
}
