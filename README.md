# Tray Drawer

<a href="https://liberapay.com/BeatLink/donate"><img alt="Donate using Liberapay" src="https://liberapay.com/assets/widgets/donate.svg"></a>

![The drawer expanding and collapsing on the panel](screenshot.gif)

A Cinnamon panel applet that hosts every kind of tray icon in one place and tucks away the ones you
do not need to see.

- **A drawer for hidden icons**: the tray expands along the panel to show them.
- **All tray icon types**: XApp status icons, StatusNotifierItem / AppIndicator icons (Cinnamon's
  `xapp-sn-watcher` turns these into XApp icons), and legacy XEmbed icons.
- **Hides other applets too**: pick any applet on the same panel and it disappears while the tray
  is collapsed.

## Install

```sh
ln -s "$PWD/tray-drawer@beatlink/files/tray-drawer@beatlink" \
    ~/.local/share/cinnamon/applets/tray-drawer@beatlink
```

Then add **Tray Drawer** from *System Settings → Applets*, and remove the stock
**System Tray** and **XApp Status Applet**. This applet does both of their jobs; while the stock
System Tray is running it keeps the legacy XEmbed icons, and the XApp Status Applet would show every
XApp icon a second time.

## Use

- **Left-click the arrow** to expand or collapse the drawer.
- **Middle-click the arrow** to show or hide the hidden applets.
- **Scroll on the arrow** to open (up or left) or close (down or right).
- **Right-click the tray** (or Ctrl + right-click an icon) for two lists:
  - *Tray icons shown on the panel*: switch an icon on to keep it on the panel at all times.
  - *Applets to hide*: switch an applet on to tuck it away with the hidden icons.
- Both lists have up and down arrows beside each switch to move an item along the panel. Icon order
  is stored by the applet; applet order is written to Cinnamon's own panel layout, exactly as panel
  edit mode would.
- Icon switches are keyed by the icon's name (the XApp name, or the window class of a legacy icon),
  so two instances of the same app share one switch.
- In panel edit mode every icon and applet is shown on the panel so hidden applets can still be
  moved or removed.

New icons start hidden; turn off *Hide new tray icons* in the settings to keep them on the panel.

## License

GPL-3.0-or-later.
