// Collapsible System Tray: one tray for XApp, StatusNotifier and legacy XEmbed icons.
// Icons and other panel applets marked as hidden are tucked away, either in a drawer
// that slides out along the panel or in a popup grid above the tray.

const Applet = imports.ui.applet;
const AppletManager = imports.ui.appletManager;
const Cinnamon = imports.gi.Cinnamon;
const Clutter = imports.gi.Clutter;
const GLib = imports.gi.GLib;
const Gettext = imports.gettext;
const Gtk = imports.gi.Gtk;
const Main = imports.ui.main;
const Meta = imports.gi.Meta;
const PopupMenu = imports.ui.popupMenu;
const Settings = imports.ui.settings;
const SignalManager = imports.misc.signalManager;
const St = imports.gi.St;
const Tooltips = imports.ui.tooltips;
const XApp = imports.gi.XApp;

const UUID = "collapsible-systray@beatlink";
const SYSTRAY_UUID = "systray@cinnamon.org";
const XAPP_STATUS_UUID = "xapp-status@cinnamon.org";
const XAPP_NAME_PREFIX = "org.x.StatusIcon.";
const DRAWER_ANIMATION_TIME = 200;
const FALLBACK_ICON_SIZE = 16;
const XEMBED_REVEAL_DELAY = 1000;
const XEMBED_QUICK_REVEAL_DELAY = 100;
const RECENT_ROLE_TIME = 5 * 1000 * 1000;

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");

function _(text) {
    return Gettext.dgettext(UUID, text);
}

// ============================================================================
// Helpers
// ============================================================================

function is_vertical_side(side) {
    return side === St.Side.LEFT || side === St.Side.RIGHT;
}

function remove_source(source_id) {
    if (source_id > 0) {
        GLib.source_remove(source_id);
    }
    return 0;
}

function move_actor(actor, new_parent) {
    let old_parent = actor.get_parent();
    if (old_parent === new_parent) {
        return;
    }
    if (old_parent) {
        old_parent.remove_child(actor);
    }
    new_parent.add_child(actor);
}

// Ctrl + right click on an icon opens the tray's own menu instead of the app's.
function is_tray_menu_click(event) {
    return event.get_button() === Clutter.BUTTON_SECONDARY && (event.get_state() & Clutter.ModifierType.CONTROL_MASK) !== 0;
}

// ============================================================================
// XApp status icons (also StatusNotifier icons, bridged by xapp-sn-watcher)
// ============================================================================

class XAppItem {
    constructor(applet, proxy) {
        this.applet = applet;
        this._applet = applet;
        this.proxy = proxy;
        this.kind = "xapp";
        this.in_popup = false;
        this.icon_loader_handle = null;

        this.actor = new St.BoxLayout({
            style_class: "applet-box",
            reactive: !global.settings.get_boolean("panel-edit-mode"),
            track_hover: true,
            x_expand: true,
            y_expand: true
        });
        this.icon_holder = new St.Bin();
        this.label = new St.Label({ y_align: Clutter.ActorAlign.CENTER });
        this.actor.add_actor(this.icon_holder);
        this.actor.add_actor(this.label);

        this.tooltip = new Tooltips.PanelItemTooltip(this, "", applet.orientation);

        this.actor.connect("button-press-event", (actor, event) => this.on_button_press(actor, event));
        this.actor.connect("button-release-event", (actor, event) => this.on_button_release(actor, event));
        this.actor.connect("scroll-event", (actor, event) => this.on_scroll(actor, event));
        this.actor.connect("enter-event", () => { this.tooltip.preventShow = this.in_popup; });
        this.properties_changed_id = this.proxy.connect("g-properties-changed", (proxy, changed) => this.on_properties_changed(changed));

        this.refresh();
    }

    get key() {
        return "xapp:" + this.label_text;
    }

    get label_text() {
        let name = this.proxy.name || this.proxy.get_name();
        return name.startsWith(XAPP_NAME_PREFIX) ? name.slice(XAPP_NAME_PREFIX.length) : name;
    }

    get is_busy() {
        return this.proxy.primary_menu_is_open || this.proxy.secondary_menu_is_open;
    }

    on_properties_changed(changed) {
        let names = changed.deep_unpack();

        if ("IconName" in names) this.set_icon_name(this.proxy.icon_name);
        if ("TooltipText" in names) this.set_tooltip_text(this.proxy.tooltip_text);
        if ("Label" in names) this.set_label(this.proxy.label);
        if ("Visible" in names) this.set_visible(this.proxy.visible);
        if ("Name" in names) this.applet.queue_place_items();
        if (("PrimaryMenuIsOpen" in names && !this.proxy.primary_menu_is_open) ||
            ("SecondaryMenuIsOpen" in names && !this.proxy.secondary_menu_is_open)) {
            this.actor.sync_hover();
        }
    }

    refresh() {
        this.set_orientation(this.applet.orientation);
        this.set_icon_name(this.proxy.icon_name);
        this.set_label(this.proxy.label);
        this.set_tooltip_text(this.proxy.tooltip_text);
        this.set_visible(this.proxy.visible);
        this.actor.queue_relayout();
    }

    set_in_popup(in_popup) {
        this.in_popup = in_popup;
        this.actor.style_class = in_popup ? "collapsible-systray-grid-item" : "applet-box";
        this.actor.x_expand = !in_popup;
        this.actor.y_expand = !in_popup;

        // The holder already centres its icon, so it only needs to fill the grid cell.
        this.icon_holder.x_expand = in_popup;
        this.icon_holder.y_expand = in_popup;
        this.set_orientation(this.applet.orientation);
        this.set_label(this.proxy.label);

        // Panel tooltips refuse to show while a menu is open, and the popup is one.
        if (in_popup) {
            this.tooltip.hide();
            this.tooltip.preventShow = true;
        } else {
            this.set_tooltip_text(this.proxy.tooltip_text);
        }
    }

    set_orientation(orientation) {
        this.actor.vertical = is_vertical_side(orientation);
        if (this.actor.vertical) {
            this.actor.add_style_class_name("vertical");
        } else {
            this.actor.remove_style_class_name("vertical");
        }
    }

    set_icon_name(icon_name) {
        if (!icon_name) {
            this.icon_loader_handle = null;
            this.icon_holder.hide();
            return;
        }

        let icon_type = icon_name.match(/symbolic/) ? St.IconType.SYMBOLIC : St.IconType.FULLCOLOR;
        let icon_size = this.applet.panel_icon_size(icon_type);
        this.proxy.icon_size = icon_size;

        // Image files may be wider than tall, so let them stretch along a horizontal panel.
        if (icon_name.includes("/") && icon_type !== St.IconType.SYMBOLIC) {
            let scaled_size = icon_size * global.ui_scale;
            this.icon_loader_handle = St.TextureCache.get_default().load_image_from_file_async(
                icon_name,
                this.actor.vertical ? scaled_size : -1,
                scaled_size,
                (cache, handle, actor) => {
                    if (handle === this.icon_loader_handle) {
                        this.icon_holder.child = actor;
                        this.icon_holder.show();
                    }
                }
            );
            return;
        }

        this.icon_loader_handle = null;
        this.icon_holder.child = new St.Icon({ icon_type: icon_type, icon_size: icon_size, icon_name: icon_name });
        this.icon_holder.show();
    }

    set_tooltip_text(text) {
        this.tooltip.preventShow = !text;
        this.tooltip.set_markup(text || "");
        if (this.tooltip.visible) {
            this.tooltip.hide();
            this.tooltip.show();
        }
    }

    set_label(text) {
        this.label.set_text(text || "");
        this.label.visible = !!text && !this.in_popup && !is_vertical_side(this.applet.orientation);
    }

    set_visible(visible) {
        if (this.actor.visible !== visible) {
            this.actor.visible = visible;
            this.applet.queue_place_items();
        }
    }

    position_for_menu(actor = this.actor) {
        let allocation = Cinnamon.util_get_transformed_allocation(actor);
        let x = Math.round(allocation.x1 / global.ui_scale);
        let y = Math.round(allocation.y1 / global.ui_scale);
        let width = Math.round((allocation.x2 - allocation.x1) / global.ui_scale);
        let height = Math.round((allocation.y2 - allocation.y1) / global.ui_scale);

        switch (this.applet.orientation) {
            case St.Side.TOP:
                return [x, y + height, Gtk.PositionType.TOP];
            case St.Side.LEFT:
                return [x + width, y, Gtk.PositionType.LEFT];
            case St.Side.RIGHT:
                return [x, y, Gtk.PositionType.RIGHT];
            case St.Side.BOTTOM:
            default:
                return [x, y, Gtk.PositionType.BOTTOM];
        }
    }

    on_button_press(actor, event) {
        this.tooltip.hide();
        this.tooltip.preventShow = true;

        if (is_tray_menu_click(event)) {
            return Clutter.EVENT_PROPAGATE;
        }
        this.applet.note_activity();

        // Inside the popup the whole click is sent at once, because the popup must close first to free the pointer.
        if (this.in_popup) {
            // The app's menu opens against the arrow, since the popup it was clicked in is about to close.
            let [x, y, side] = this.position_for_menu(this.applet.arrow_button);
            this.applet.close_grid();
            this.proxy.call_button_press(x, y, event.get_button(), event.get_time(), side, null, null);
            this.proxy.call_button_release(x, y, event.get_button(), event.get_time(), side, null, null);
            return Clutter.EVENT_STOP;
        }

        let [x, y, side] = this.position_for_menu();
        this.proxy.call_button_press(x, y, event.get_button(), event.get_time(), side, null, null);
        return Clutter.EVENT_STOP;
    }

    on_button_release(actor, event) {
        if (this.in_popup) {
            return Clutter.EVENT_STOP;
        }

        let [x, y, side] = this.position_for_menu();
        this.proxy.call_button_release(x, y, event.get_button(), event.get_time(), side, null, null);
        return Clutter.EVENT_STOP;
    }

    on_scroll(actor, event) {
        let directions = {
            [Clutter.ScrollDirection.UP]: [XApp.ScrollDirection.UP, -1],
            [Clutter.ScrollDirection.DOWN]: [XApp.ScrollDirection.DOWN, 1],
            [Clutter.ScrollDirection.LEFT]: [XApp.ScrollDirection.LEFT, -1],
            [Clutter.ScrollDirection.RIGHT]: [XApp.ScrollDirection.RIGHT, 1]
        };
        let direction = directions[event.get_scroll_direction()];

        this.applet.note_activity();
        if (direction) {
            this.proxy.call_scroll(direction[1], direction[0], event.get_time(), null, null);
        }
        return Clutter.EVENT_STOP;
    }

    set_reactive(reactive) {
        this.actor.reactive = reactive;
    }

    destroy() {
        this.proxy.disconnect(this.properties_changed_id);
        this.tooltip.destroy();
        this.actor.destroy();
    }
}

// ============================================================================
// Legacy XEmbed tray icons
// ============================================================================

class XEmbedItem {
    constructor(applet, icon, role) {
        this.applet = applet;
        this._applet = applet;
        this.icon = icon;
        this.role = role;
        this.kind = "xembed";
        this.in_popup = false;
        this.reveal_source_id = 0;

        this.actor = new St.Bin({
            style_class: "applet-box",
            child: icon,
            reactive: !global.settings.get_boolean("panel-edit-mode")
        });
        this.actor.set_y_align(Clutter.ActorAlign.FILL);
        icon.set_x_align(Clutter.ActorAlign.CENTER);
        icon.set_y_align(Clutter.ActorAlign.FILL);

        // The icon handles its own clicks, so stop them here before they reach the tray.
        this.actor.connect("button-press-event", (actor, event) => this.on_wrapper_button_event(event));
        this.actor.connect("button-release-event", (actor, event) => this.on_wrapper_button_event(event));

        // Give the embedded window time to settle before showing it, as the stock tray does.
        icon.visible = false;
        icon.opacity = 0;
        this.reveal_source_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, applet.xembed_reveal_delay(role), () => {
            this.reveal_source_id = 0;
            if (icon.is_finalized()) {
                return GLib.SOURCE_REMOVE;
            }
            icon.reactive = true;
            icon.visible = true;
            this.resize();
            icon.ease({ opacity: 255, duration: 400, mode: Clutter.AnimationMode.EASE_OUT_QUAD });
            icon.connect("event", (actor, event) => this.on_event(event));
            return GLib.SOURCE_REMOVE;
        });
    }

    get key() {
        return "xembed:" + this.role;
    }

    get label_text() {
        return this.role;
    }

    get is_busy() {
        return false;
    }

    resize() {
        let size = this.applet.panel_icon_size(St.IconType.FULLCOLOR) * global.ui_scale;
        this.icon.set_size(size, size);
    }

    refresh() {
        if (this.icon.visible) {
            this.resize();
        }
    }

    set_in_popup(in_popup) {
        this.in_popup = in_popup;
        this.actor.style_class = in_popup ? "collapsible-systray-grid-item" : "applet-box";
        this.icon.set_y_align(in_popup ? Clutter.ActorAlign.CENTER : Clutter.ActorAlign.FILL);
    }

    set_orientation(orientation) {
    }

    set_reactive(reactive) {
        this.actor.reactive = reactive;
    }

    on_wrapper_button_event(event) {
        return is_tray_menu_click(event) ? Clutter.EVENT_PROPAGATE : Clutter.EVENT_STOP;
    }

    // Wrapping the call in a modal span drops the pointer grab so the app can open its own menu.
    forward_event(event_type, event) {
        global.begin_modal(event.get_time(), Meta.ModalOptions.POINTER_ALREADY_GRABBED);
        let result = this.icon.handle_event(event_type, event);
        global.end_modal(event.get_time());
        return result;
    }

    on_event(event) {
        let event_type = event.type();

        if (event_type === Clutter.EventType.ENTER) {
            this.actor.add_style_pseudo_class("hover");
        } else if (event_type === Clutter.EventType.LEAVE) {
            this.actor.remove_style_pseudo_class("hover");
        }

        let is_button_event = event_type === Clutter.EventType.BUTTON_PRESS || event_type === Clutter.EventType.BUTTON_RELEASE;
        if (is_button_event && is_tray_menu_click(event)) {
            return Clutter.EVENT_PROPAGATE;
        }
        if (event_type === Clutter.EventType.BUTTON_PRESS) {
            this.applet.note_activity();
        }

        if (this.in_popup && event_type === Clutter.EventType.BUTTON_PRESS) {
            this.applet.close_grid();
            this.forward_event(Clutter.EventType.BUTTON_PRESS, event);
            return this.icon.handle_event(Clutter.EventType.BUTTON_RELEASE, event);
        }
        if (this.in_popup && event_type === Clutter.EventType.BUTTON_RELEASE) {
            return Clutter.EVENT_STOP;
        }
        if (event_type === Clutter.EventType.BUTTON_PRESS) {
            return this.forward_event(event_type, event);
        }
        return this.icon.handle_event(event_type, event);
    }

    destroy() {
        this.reveal_source_id = remove_source(this.reveal_source_id);
        this.applet.remember_xembed_role(this.role);
        if (this.icon.get_parent() === this.actor) {
            this.actor.remove_actor(this.icon);
        }
        this.actor.destroy();
    }
}

// ============================================================================
// Applet
// ============================================================================

class CollapsibleSystrayApplet extends Applet.Applet {
    constructor(metadata, orientation, panel_height, instance_id) {
        super(orientation, panel_height, instance_id);

        this.orientation = orientation;
        this.setAllowedLayout(Applet.AllowedLayout.BOTH);
        this.actor.remove_style_class_name("applet-box");
        this.actor.add_style_class_name("collapsible-systray");
        this.actor.set_important(true);

        this.signals = new SignalManager.SignalManager(null);
        this.items = new Map();
        this.hidden_applet_actors = new Map();
        this.expanded = false;
        this.removed = false;
        this.auto_collapse_source_id = 0;
        this.hover_source_id = 0;
        this.scale_source_id = 0;
        this.sync_applets_source_id = 0;
        this.place_items_source_id = 0;
        this.xembed_enabled = false;
        this.systray_has_run = false;
        this.recently_seen_roles = new Map();

        this.bind_settings(instance_id);
        this.state = this.compute_state();
        this.build_panel_widgets();
        this.build_grid_menu();
        this.build_context_menu();

        this.monitor = new XApp.StatusIconMonitor();
        this.signals.connect(this.monitor, "icon-added", (monitor, proxy) => this.on_xapp_icon_added(proxy));
        this.signals.connect(this.monitor, "icon-removed", (monitor, proxy) => this.on_xapp_icon_removed(proxy));
        this.signals.connect(Main.systrayManager, "changed", () => this.on_systray_roles_changed());
        this.signals.connect(Gtk.IconTheme.get_default(), "changed", () => this.refresh_items());
        this.signals.connect(global.settings, "changed::panel-edit-mode", () => this.on_panel_edit_mode_changed());
        this.signals.connect(global, "scale-changed", () => this.on_ui_scale_changed());
        if (this.panel) {
            this.signals.connect(this.panel, "icon-size-changed", () => this.refresh_items());
        }

        if (AppletManager.getRunningInstancesForUuid(XAPP_STATUS_UUID).length > 0) {
            global.logWarning(`${UUID}: the XApp Status applet is also on a panel, so its icons will show twice`);
        }

        this.update_layout();
    }

    // ------------------------------------------------------------------------
    // Settings
    // ------------------------------------------------------------------------

    bind_settings(instance_id) {
        this.settings = new Settings.AppletSettings(this, UUID, instance_id);

        let on_layout_changed = () => this.update_layout();
        this.settings.bind("display-mode", "display_mode", on_layout_changed);
        this.settings.bind("grid-columns", "grid_columns", on_layout_changed);
        this.settings.bind("collapse-new-icons", "collapse_new_icons", on_layout_changed);
        this.settings.bind("item-visibility", "item_visibility", on_layout_changed);
        this.settings.bind("hidden-applets", "hidden_applets", () => this.sync_applets());
        this.settings.bind("expand-on-hover", "expand_on_hover");
        this.settings.bind("hover-delay", "hover_delay");
        this.settings.bind("auto-collapse", "auto_collapse");
        this.settings.bind("auto-collapse-delay", "auto_collapse_delay");
    }

    get is_grid_mode() {
        return this.display_mode === "grid";
    }

    get in_edit_mode() {
        return global.settings.get_boolean("panel-edit-mode");
    }

    // Falls back to a usual size while the panel cannot report one yet.
    panel_icon_size(icon_type = St.IconType.FULLCOLOR) {
        let size = this.getPanelIconSize(icon_type);
        return typeof size === "number" ? size : FALLBACK_ICON_SIZE;
    }

    is_item_hidden(item) {
        let choice = this.item_visibility[item.key];
        if (choice === "hidden") return true;
        if (choice === "shown") return false;
        return this.collapse_new_icons;
    }

    set_item_hidden(item, hidden) {
        let visibility = Object.assign({}, this.item_visibility);
        visibility[item.key] = hidden ? "hidden" : "shown";
        this.item_visibility = visibility;
        this.update_layout();
    }

    set_applet_hidden(key, hidden) {
        let applets = Object.assign({}, this.hidden_applets);
        if (hidden) {
            applets[key] = true;
        } else {
            delete applets[key];
        }
        this.hidden_applets = applets;
        this.sync_applets();
    }

    // ------------------------------------------------------------------------
    // Widgets
    // ------------------------------------------------------------------------

    build_panel_widgets() {
        let vertical = is_vertical_side(this.orientation);

        this.pinned_box = new St.BoxLayout({ vertical: vertical, style_class: "collapsible-systray-pinned" });
        this.drawer_box = new St.BoxLayout({ vertical: vertical, style_class: "collapsible-systray-drawer" });

        // The drawer slides by resizing this clipping frame while the icons inside keep their size.
        this.drawer_clip = new St.Widget({ clip_to_allocation: true, visible: false });
        this.drawer_clip.add_child(this.drawer_box);
        this.drawer_shown = false;
        this.cross_size_source_id = 0;
        this.actor.connect("notify::height", () => this.queue_drawer_cross_size());
        this.actor.connect("notify::width", () => this.queue_drawer_cross_size());
        this.update_drawer_constraints();
        this.arrow_icon = new St.Icon({ icon_type: St.IconType.SYMBOLIC, style_class: "system-status-icon" });
        this.arrow_button = new St.Bin({
            style_class: "applet-box collapsible-systray-arrow",
            reactive: true,
            track_hover: true,
            child: this.arrow_icon
        });
        this.arrow_tooltip = new Tooltips.PanelItemTooltip({ actor: this.arrow_button, _applet: this }, "", this.orientation);
        this.arrow_button.connect("enter-event", () => this.on_arrow_entered());
        this.arrow_button.connect("scroll-event", (actor, event) => this.on_arrow_scrolled(event));

        // The arrow comes last so it stays put under the pointer while the drawer opens.
        this.actor.add_actor(this.pinned_box);
        this.actor.add_actor(this.drawer_clip);
        this.actor.add_actor(this.arrow_button);
    }

    build_grid_menu() {
        this.grid_menu_manager = new PopupMenu.PopupMenuManager(this);
        this.grid_menu = new PopupMenu.PopupMenu(this.arrow_button, this.orientation);
        this.grid_menu.actor.add_style_class_name("collapsible-systray-popup");
        Main.uiGroup.add_actor(this.grid_menu.actor);
        this.grid_menu.actor.hide();
        this.grid_menu_manager.addMenu(this.grid_menu);
        this.grid_menu.connect("open-state-changed", (menu, open) => {
            this.arrow_button.change_style_pseudo_class("checked", open);
            this.update_arrow();
        });

        this.grid = new St.BoxLayout({ vertical: true, style_class: "collapsible-systray-grid" });
        this.grid_empty_label = new St.Label({ text: _("No hidden icons"), style_class: "collapsible-systray-grid-empty" });
        this.grid_menu.box.add_actor(this.grid);
        this.grid_menu.box.add_actor(this.grid_empty_label);

        this.grid_applets_separator = new PopupMenu.PopupSeparatorMenuItem();
        this.grid_applets_item = new PopupMenu.PopupIconMenuItem("", "view-reveal-symbolic", St.IconType.SYMBOLIC);
        this.grid_applets_item.connect("activate", () => this.set_expanded(!this.expanded));
        this.grid_menu.addMenuItem(this.grid_applets_separator);
        this.grid_menu.addMenuItem(this.grid_applets_item);
    }

    build_context_menu() {
        this.icons_submenu = new PopupMenu.PopupSubMenuMenuItem(_("Tray icons shown on the panel"));
        this.applets_submenu = new PopupMenu.PopupSubMenuMenuItem(_("Applets to hide"));
        this._applet_context_menu.addMenuItem(this.icons_submenu, 0);
        this._applet_context_menu.addMenuItem(this.applets_submenu, 1);
        this._applet_context_menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(), 2);
        this._applet_context_menu.connect("open-state-changed", (menu, open) => {
            if (open) {
                this.fill_context_menu();
            }
        });
    }

    fill_context_menu() {
        this.icons_submenu.menu.removeAll();
        let items = this.sorted_items();
        for (let item of items) {
            let switch_item = new PopupMenu.PopupSwitchMenuItem(item.label_text, !this.is_item_hidden(item));
            switch_item.connect("toggled", (menu_item, shown) => this.set_item_hidden(item, !shown));
            this.icons_submenu.menu.addMenuItem(switch_item);
        }
        if (items.length === 0) {
            let empty_item = new PopupMenu.PopupMenuItem(_("No tray icons"), { reactive: false });
            this.icons_submenu.menu.addMenuItem(empty_item);
        }

        this.applets_submenu.menu.removeAll();
        for (let [key, applet] of this.panel_applets()) {
            let name = applet._meta ? applet._(applet._meta.name) : applet._uuid;
            let switch_item = new PopupMenu.PopupSwitchMenuItem(name, !!this.hidden_applets[key]);
            switch_item.connect("toggled", (menu_item, hidden) => this.set_applet_hidden(key, hidden));
            this.applets_submenu.menu.addMenuItem(switch_item);
        }
    }

    // ------------------------------------------------------------------------
    // Layout
    // ------------------------------------------------------------------------

    sorted_items() {
        return [...this.items.values()].sort((first, second) =>
            GLib.utf8_collate(first.label_text.toLowerCase(), second.label_text.toLowerCase()));
    }

    // Works out once which icons and applets are tucked away, for the grid and the arrow to read.
    compute_state() {
        let hidden_items = this.in_edit_mode ? [] :
            this.sorted_items().filter(item => this.is_item_hidden(item) && item.actor.visible);
        let hidden_applet_count = this.panel_applets().filter(([key]) => this.hidden_applets[key]).length;
        return {
            hidden_items: hidden_items,
            hidden_applet_count: hidden_applet_count,
            has_hidden_applets: hidden_applet_count > 0
        };
    }

    // Puts every icon on the panel, in the drawer or in the popup grid, and redraws the arrow.
    place_items() {
        this.place_items_source_id = remove_source(this.place_items_source_id);
        let cell_size = this.grid_cell_size();
        let hidden_count = 0;

        for (let item of this.sorted_items()) {
            // Panel edit mode puts every icon on the panel so the whole tray can be seen.
            let hidden = !this.in_edit_mode && this.is_item_hidden(item);
            let in_popup = hidden && this.is_grid_mode;
            let target = hidden ? this.drawer_box : this.pinned_box;

            // Grid cells fill row by row, and icons the app has hidden go last so they leave no gap.
            if (in_popup) {
                let row = Math.floor(hidden_count / Math.max(1, this.grid_columns));
                target = this.grid_row(row);
            }

            move_actor(item.actor, target);
            item.set_in_popup(in_popup);
            if (in_popup) {
                item.actor.set_size(cell_size, cell_size);
            } else {
                item.actor.set_size(-1, -1);
            }
            target.set_child_at_index(item.actor, -1);
            if (hidden && item.actor.visible) {
                hidden_count++;
            }
        }

        for (let row of this.grid.get_children()) {
            if (row.get_n_children() === 0) {
                row.destroy();
            }
        }

        this.state = this.compute_state();
        this.update_drawer();
        this.update_grid();
        this.update_arrow();
    }

    // Many icon changes arrive together, so the icons are placed once they settle.
    queue_place_items() {
        if (this.place_items_source_id > 0) {
            return;
        }
        this.place_items_source_id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.place_items_source_id = 0;
            if (!this.removed) {
                this.place_items();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    update_layout() {
        if (!this.is_grid_mode) {
            this.close_grid();
        }
        this.place_items();
        this.sync_applets();
    }

    // Keeps the icons pinned to the arrow's side of the frame.
    update_drawer_constraints() {
        let vertical = is_vertical_side(this.orientation);
        this.drawer_box.clear_constraints();
        this.drawer_box.add_constraint(new Clutter.AlignConstraint({
            source: this.drawer_clip,
            align_axis: vertical ? Clutter.AlignAxis.Y_AXIS : Clutter.AlignAxis.X_AXIS,
            factor: 1.0
        }));
        this.queue_drawer_cross_size();
    }

    // Copies the panel's thickness onto the icon row by value, since binding the two sizes makes Clutter loop forever.
    queue_drawer_cross_size() {
        if (this.cross_size_source_id > 0) {
            return;
        }
        this.cross_size_source_id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.cross_size_source_id = 0;
            let vertical = is_vertical_side(this.orientation);
            let thickness = vertical ? this.actor.width : this.actor.height;
            if (vertical) {
                this.drawer_box.set_size(thickness, -1);
            } else {
                this.drawer_box.set_size(-1, thickness);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    update_drawer(animate = false) {
        let show = !this.is_grid_mode && (this.expanded || this.in_edit_mode);
        if (show === this.drawer_shown) {
            return;
        }
        this.drawer_shown = show;

        let clip = this.drawer_clip;
        let vertical = is_vertical_side(this.orientation);
        let property = vertical ? "height" : "width";
        let start_size = clip.visible ? clip[property] : 0;

        clip.remove_all_transitions();
        clip.set_size(-1, -1);

        if (!animate || !Main.animations_enabled || this.in_edit_mode) {
            clip.visible = show;
            return;
        }

        clip.show();
        let natural_size = vertical ? clip.get_preferred_height(-1)[1] : clip.get_preferred_width(-1)[1];
        clip[property] = start_size;
        clip.ease({
            [property]: show ? natural_size : 0,
            duration: DRAWER_ANIMATION_TIME,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                clip.set_size(-1, -1);
                clip.visible = this.drawer_shown;
            }
        });
    }

    grid_cell_size() {
        return (this.panel_icon_size(St.IconType.FULLCOLOR) + 16) * global.ui_scale;
    }

    grid_row(index) {
        let rows = this.grid.get_children();
        while (rows.length <= index) {
            let row = new St.BoxLayout({ style_class: "collapsible-systray-grid-row" });
            this.grid.add_child(row);
            rows.push(row);
        }
        return rows[index];
    }

    update_grid() {
        let shown_cells = this.grid.get_children()
            .reduce((count, row) => count + row.get_children().filter(child => child.visible).length, 0);
        this.grid.visible = shown_cells > 0;
        this.grid_empty_label.visible = shown_cells === 0;

        this.grid_applets_separator.actor.visible = this.state.has_hidden_applets;
        this.grid_applets_item.actor.visible = this.state.has_hidden_applets;
        this.grid_applets_item.label.set_text(this.expanded ? _("Hide applets again") : _("Show hidden applets"));
    }

    // The arrow points toward where the hidden icons will appear.
    update_arrow() {
        this.arrow_button.visible = this.state.hidden_items.length > 0 || this.state.has_hidden_applets || this.in_edit_mode;

        let vertical = is_vertical_side(this.orientation);
        let icon_name;

        if (this.is_grid_mode) {
            let outward = {
                [St.Side.BOTTOM]: "pan-up-symbolic",
                [St.Side.TOP]: "pan-down-symbolic",
                [St.Side.LEFT]: "pan-end-symbolic",
                [St.Side.RIGHT]: "pan-start-symbolic"
            };
            let inward = {
                [St.Side.BOTTOM]: "pan-down-symbolic",
                [St.Side.TOP]: "pan-up-symbolic",
                [St.Side.LEFT]: "pan-start-symbolic",
                [St.Side.RIGHT]: "pan-end-symbolic"
            };
            icon_name = (this.grid_menu.isOpen ? inward : outward)[this.orientation];
            this.arrow_tooltip.set_text(_("Show hidden icons"));
        } else {
            if (vertical) {
                icon_name = this.expanded ? "pan-down-symbolic" : "pan-up-symbolic";
            } else {
                icon_name = this.expanded ? "pan-end-symbolic" : "pan-start-symbolic";
            }
            this.arrow_tooltip.set_text(this.expanded ? _("Collapse") : _("Show hidden icons"));
        }

        this.arrow_icon.icon_name = icon_name;
        this.arrow_icon.icon_size = this.panel_icon_size(St.IconType.SYMBOLIC);
    }

    refresh_items() {
        for (let item of this.items.values()) {
            item.refresh();
        }
        this.place_items();
    }

    // ------------------------------------------------------------------------
    // Expanding and collapsing
    // ------------------------------------------------------------------------

    set_expanded(expanded) {
        this.auto_collapse_source_id = remove_source(this.auto_collapse_source_id);
        this.expanded = expanded;

        this.update_drawer(true);
        this.update_grid();
        this.update_arrow();
        this.sync_applets();

        if (expanded) {
            this.schedule_auto_collapse();
        }
    }

    close_grid() {
        if (this.grid_menu.isOpen) {
            this.grid_menu.close(false);
        }
    }

    schedule_auto_collapse() {
        this.auto_collapse_source_id = remove_source(this.auto_collapse_source_id);
        if (!this.auto_collapse || this.in_edit_mode) {
            return;
        }

        this.auto_collapse_source_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.auto_collapse_delay * 1000, () => {
            this.auto_collapse_source_id = 0;
            if (this.is_in_use()) {
                this.schedule_auto_collapse();
            } else {
                this.set_expanded(false);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // True while the pointer rests on the tray or a revealed applet, or one of their menus is open.
    is_in_use() {
        if (this.actor.hover || this._applet_context_menu.isOpen) {
            return true;
        }
        for (let item of this.items.values()) {
            if (item.is_busy) {
                return true;
            }
        }
        for (let [key, applet] of this.panel_applets()) {
            if (!this.hidden_applets[key]) {
                continue;
            }
            let menu_open = (applet._menuManager && applet._menuManager._activeMenu) ||
                            (applet.menuManager && applet.menuManager._activeMenu);
            if (applet.actor.hover || menu_open) {
                return true;
            }
        }
        return false;
    }

    // Restarts the auto-collapse wait after the user works with an icon.
    note_activity() {
        if (this.expanded) {
            this.schedule_auto_collapse();
        }
    }

    // True when the click landed on a tray icon rather than on the arrow.
    is_icon_event(event) {
        let source = event.get_source();
        return !!source && (this.pinned_box.contains(source) || this.drawer_clip.contains(source));
    }

    on_applet_clicked(event) {
        if (this.is_icon_event(event)) {
            return;
        }
        this.hover_source_id = remove_source(this.hover_source_id);
        if (this.is_grid_mode) {
            this.grid_menu.toggle();
        } else {
            this.set_expanded(!this.expanded);
        }
    }

    on_applet_middle_clicked(event) {
        if (this.is_icon_event(event)) {
            return;
        }
        this.set_expanded(!this.expanded);
    }

    // Scrolling up or left over the arrow shows the hidden icons, and down or right hides them.
    on_arrow_scrolled(event) {
        let direction = event.get_scroll_direction();
        if (direction === Clutter.ScrollDirection.SMOOTH || this.in_edit_mode) {
            return Clutter.EVENT_STOP;
        }

        let open = direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.LEFT;
        if (this.is_grid_mode) {
            if (open && !this.grid_menu.isOpen) {
                this.grid_menu.open(true);
            } else if (!open) {
                this.close_grid();
            }
        } else if (open !== this.expanded) {
            this.set_expanded(open);
        }
        return Clutter.EVENT_STOP;
    }

    on_arrow_entered() {
        if (!this.expand_on_hover || this.in_edit_mode) {
            return;
        }

        this.hover_source_id = remove_source(this.hover_source_id);
        this.hover_source_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.hover_delay, () => {
            this.hover_source_id = 0;
            if (!this.arrow_button.hover) {
                return GLib.SOURCE_REMOVE;
            }
            if (this.is_grid_mode && !this.grid_menu.isOpen) {
                this.grid_menu.open(true);
            } else if (!this.is_grid_mode && !this.expanded) {
                this.set_expanded(true);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------------------
    // Hiding other applets
    // ------------------------------------------------------------------------

    // Lists [key, applet] for every other applet on this panel.
    panel_applets() {
        if (!this.panel) {
            return [];
        }
        return AppletManager.definitions
            .filter(definition => definition && definition.applet && definition.applet !== this &&
                                  definition.panelId === this.panel.panelId)
            .map(definition => [`${definition.uuid}#${definition.applet_id}`, definition.applet]);
    }

    // Hides chosen applets while collapsed and gives them back when expanded or in panel edit mode.
    sync_applets() {
        let collapsed = !this.expanded && !this.in_edit_mode && !this.removed;
        let current_actors = new Set();

        for (let [key, applet] of this.panel_applets()) {
            let actor = applet.actor;
            current_actors.add(actor);
            let should_hide = collapsed && !!this.hidden_applets[key];
            let tracked = this.hidden_applet_actors.has(actor);

            if (should_hide && !tracked && actor.visible) {
                actor.hide();
                let visible_id = actor.connect("notify::visible", () => {
                    if (actor.visible && this.hidden_applet_actors.has(actor)) {
                        actor.hide();
                    }
                });
                this.hidden_applet_actors.set(actor, visible_id);
            } else if (!should_hide && tracked) {
                actor.disconnect(this.hidden_applet_actors.get(actor));
                this.hidden_applet_actors.delete(actor);
                actor.show();
            }
        }

        // Applets that left this panel get their visibility back, unless they are already destroyed.
        for (let [actor, visible_id] of this.hidden_applet_actors) {
            if (current_actors.has(actor)) {
                continue;
            }
            this.hidden_applet_actors.delete(actor);
            if (!actor.is_finalized()) {
                actor.disconnect(visible_id);
                actor.show();
            }
        }

        this.state = this.compute_state();
        this.update_grid();
        this.update_arrow();
    }

    // Applets keep loading after this one at startup, so catch them as they arrive.
    queue_sync_applets() {
        if (this.sync_applets_source_id > 0) {
            return;
        }
        this.sync_applets_source_id = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.sync_applets_source_id = 0;
            this.sync_applets();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------------------
    // XApp icons
    // ------------------------------------------------------------------------

    xapp_key(proxy) {
        return proxy.get_name() + proxy.get_object_path();
    }

    is_role_replaced(role) {
        return Main.systrayManager.getRoles().indexOf(role.toLowerCase()) !== -1;
    }

    on_xapp_icon_added(proxy) {
        let key = this.xapp_key(proxy);
        if (this.items.has(key) || this.is_role_replaced(proxy.name)) {
            return;
        }
        this.items.set(key, new XAppItem(this, proxy));
        this.queue_place_items();
    }

    on_xapp_icon_removed(proxy) {
        let key = this.xapp_key(proxy);
        let item = this.items.get(key);
        if (item) {
            item.destroy();
            this.items.delete(key);
            this.queue_place_items();
        }
    }

    // Drops icons that another applet now stands in for, and brings back any that lost their stand-in.
    on_systray_roles_changed() {
        for (let [key, item] of this.items) {
            if (item.kind === "xapp" && this.is_role_replaced(item.proxy.name)) {
                item.destroy();
                this.items.delete(key);
            }
        }
        for (let proxy of this.monitor.list_icons()) {
            this.on_xapp_icon_added(proxy);
        }
        if (this.xembed_enabled) {
            Main.statusIconDispatcher.redisplay();
        }
        this.queue_place_items();
    }

    // ------------------------------------------------------------------------
    // XEmbed icons
    // ------------------------------------------------------------------------

    start_xembed() {
        if (Meta.is_wayland_compositor() || this.xembed_enabled) {
            return;
        }
        if (this.systray_is_running()) {
            this.systray_has_run = true;
            global.logWarning(`${UUID}: the stock System Tray applet is running, so it keeps the legacy tray icons`);
            return;
        }

        if (this.dispatcher_needs_start()) {
            Main.statusIconDispatcher.start(this.actor.get_parent().get_parent());
            Main.statusIconDispatcher._collapsible_systray_started = true;
        }
        global.trayReloading = false;
        this.xembed_enabled = true;

        this.update_tray_orientation();
        this.signals.connect(Main.statusIconDispatcher, "status-icon-added", (dispatcher, icon, role) => this.on_xembed_icon_added(icon, role));
        this.signals.connect(Main.statusIconDispatcher, "status-icon-removed", (dispatcher, icon) => this.on_xembed_icon_removed(icon));
        this.signals.connect(Main.statusIconDispatcher, "before-redisplay", () => this.clear_xembed_items());
        Main.statusIconDispatcher.redisplay();
    }

    // The tray manager takes the screen only once, so skip it after a reload or after the stock tray took it.
    dispatcher_needs_start() {
        return !global.trayReloading && !Main.statusIconDispatcher._collapsible_systray_started && !this.systray_has_run;
    }

    systray_is_running() {
        return AppletManager.getRunningInstancesForUuid(SYSTRAY_UUID).length > 0;
    }

    // Takes over the legacy icons once the stock System Tray is gone, and only warns if it comes back.
    on_enabled_applets_changed() {
        if (!this.xembed_enabled) {
            this.start_xembed();
        } else if (this.systray_is_running() && !this.systray_has_run) {
            this.systray_has_run = true;
            global.logWarning(`${UUID}: the stock System Tray applet was added, so legacy tray icons may move to it`);
        }
    }

    // Remembers when a legacy icon went away, so the same app can come back without the long wait.
    remember_xembed_role(role) {
        this.recently_seen_roles.set(role, GLib.get_monotonic_time());
    }

    xembed_reveal_delay(role) {
        let now = GLib.get_monotonic_time();
        for (let [seen_role, seen_time] of this.recently_seen_roles) {
            if (now - seen_time > RECENT_ROLE_TIME) {
                this.recently_seen_roles.delete(seen_role);
            }
        }
        return this.recently_seen_roles.has(role) ? XEMBED_QUICK_REVEAL_DELAY : XEMBED_REVEAL_DELAY;
    }

    update_tray_orientation() {
        if (!this.xembed_enabled) {
            return;
        }
        let vertical = is_vertical_side(this.orientation);
        Main.statusIconDispatcher.set_tray_orientation(vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL);
    }

    on_xembed_icon_added(icon, role) {
        if (this.systray_is_running() || this.is_role_replaced(role)) {
            return;
        }
        global.log(`${UUID}: adding tray icon ${role}`);
        this.items.set(icon, new XEmbedItem(this, icon, role));
        this.queue_place_items();
    }

    on_xembed_icon_removed(icon) {
        let item = this.items.get(icon);
        if (item) {
            item.destroy();
            this.items.delete(icon);
            this.queue_place_items();
        }
    }

    clear_xembed_items() {
        for (let [key, item] of this.items) {
            if (item.kind === "xembed") {
                item.destroy();
                this.items.delete(key);
            }
        }
    }

    // ------------------------------------------------------------------------
    // Cinnamon hooks
    // ------------------------------------------------------------------------

    on_applet_added_to_panel() {
        this.removed = false;
        this.start_xembed();
        this.signals.connect(global.settings, "changed::enabled-applets", () => this.on_enabled_applets_changed());

        for (let proxy of this.monitor.list_icons()) {
            this.on_xapp_icon_added(proxy);
        }
        this.place_items();

        if (this.panel) {
            for (let zone of [this.panel._leftBox, this.panel._centerBox, this.panel._rightBox]) {
                this.signals.connect(zone, "actor-added", () => this.queue_sync_applets());
            }
        }
        this.queue_sync_applets();
    }

    on_applet_reloaded() {
        global.trayReloading = this.xembed_enabled;
    }

    on_applet_removed_from_panel() {
        this.removed = true;
        this.signals.disconnectAllSignals();
        this.hover_source_id = remove_source(this.hover_source_id);
        this.auto_collapse_source_id = remove_source(this.auto_collapse_source_id);
        this.scale_source_id = remove_source(this.scale_source_id);
        this.sync_applets_source_id = remove_source(this.sync_applets_source_id);
        this.place_items_source_id = remove_source(this.place_items_source_id);
        this.cross_size_source_id = remove_source(this.cross_size_source_id);

        for (let [actor, visible_id] of this.hidden_applet_actors) {
            if (!actor.is_finalized()) {
                actor.disconnect(visible_id);
                actor.show();
            }
        }
        this.hidden_applet_actors.clear();

        for (let item of this.items.values()) {
            item.destroy();
        }
        this.items.clear();

        this.grid_menu.destroy();
        this.arrow_tooltip.destroy();
        this.settings.finalize();
        this.monitor = null;
    }

    on_panel_edit_mode_changed() {
        let reactive = !this.in_edit_mode;
        for (let item of this.items.values()) {
            item.set_reactive(reactive);
        }
        if (this.in_edit_mode) {
            this.close_grid();
        } else {
            this.expanded = false;
        }
        this.place_items();
        this.sync_applets();
    }

    on_orientation_changed(orientation) {
        this.orientation = orientation;
        let vertical = is_vertical_side(orientation);
        this.pinned_box.vertical = vertical;
        this.drawer_box.vertical = vertical;
        this.update_drawer_constraints();
        this.grid_menu.setArrowSide(orientation);

        for (let item of this.items.values()) {
            item.set_orientation(orientation);
        }
        this.update_tray_orientation();
        this.refresh_items();
    }

    on_panel_icon_size_changed(size) {
        this.refresh_items();
    }

    on_ui_scale_changed() {
        this.scale_source_id = remove_source(this.scale_source_id);
        this.scale_source_id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            this.scale_source_id = 0;
            this.refresh_items();
            return GLib.SOURCE_REMOVE;
        });
    }
}

function main(metadata, orientation, panel_height, instance_id) {
    return new CollapsibleSystrayApplet(metadata, orientation, panel_height, instance_id);
}
