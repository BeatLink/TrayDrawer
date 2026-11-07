# Collapsible System Tray

A Cinnamon panel applet that hosts every kind of tray icon in one place and tucks away the ones you
do not need to see.

- **Two ways to show hidden icons**: a drawer that expands the tray along the panel, or a popup grid
  above the tray.
- **All tray icon types**: XApp status icons, StatusNotifierItem / AppIndicator icons (Cinnamon's
  `xapp-sn-watcher` turns these into XApp icons), and legacy XEmbed icons.
- **Hides other applets too**: pick any applet on the same panel and it disappears while the tray
  is collapsed.

## Install

```sh
ln -s "$PWD/collapsible-systray@beatlink/files/collapsible-systray@beatlink" \
    ~/.local/share/cinnamon/applets/collapsible-systray@beatlink
```

Then add **Collapsible System Tray** from *System Settings → Applets*, and remove the stock
**System Tray** and **XApp Status Applet**. This applet does both of their jobs; while the stock
System Tray is running it keeps the legacy XEmbed icons, and the XApp Status Applet would show every
XApp icon a second time.

## Use

- **Left-click the arrow** to open the popup or expand the drawer.
- **Middle-click the arrow** to show or hide the hidden applets.
- **Scroll on the arrow** to open (up or left) or close (down or right).
- **Right-click the tray** (or Ctrl + right-click an icon) for two lists:
  - *Tray icons shown on the panel*: switch an icon on to keep it on the panel at all times.
  - *Applets to hide*: switch an applet on to tuck it away with the hidden icons.
- Icon switches are keyed by the icon's name (the XApp name, or the window class of a legacy icon),
  so two instances of the same app share one switch.
- In panel edit mode every icon and applet is shown on the panel so hidden applets can still be
  moved or removed.

New icons start hidden; turn off *Hide new tray icons* in the settings to keep them on the panel.

## Hidden applets in the popup grid

Hidden applets are not moved into the popup grid. An applet belongs to its panel: panel edit mode
drags it there, its own menus open against it and close the popup when they take the pointer, and
Cinnamon saves its position from it. Instead, in grid mode the popup has a *Show hidden applets*
button (or middle-click the arrow) that brings them back on the panel until the tray collapses.

## License

GPL-3.0-or-later.
