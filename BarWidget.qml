import QtQuick
import Quickshell
import Quickshell.Io
import qs.Ui

// Bar button for the Chromium ad blocker. It reads the blocker's own statistics
// file for the tooltip, and a click opens a terminal showing status and
// statistics. Nothing here is looked up on PATH: the terminal is an absolute
// path, the command is this plugin's own checkout run by an absolute bash, the
// argv is fixed, and the child gets a fixed system PATH. No network, no shell
// string, and nothing parsed but one small JSON file the blocker itself writes.
BarWidget {
  id: root
  moduleName: "fans.omarchy.chromium-ad-blocker"

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  readonly property string home: Quickshell.env("HOME") || ""
  // This file's folder as a plain path. Qt.resolvedUrl gives a file:// URL.
  readonly property string pluginDir: {
    var url = Qt.resolvedUrl(".").toString()
    return decodeURIComponent(url.replace(/^file:\/\//, "")).replace(/\/$/, "")
  }
  readonly property string cliPath: pluginDir + "/bin/omarchy-adblock"

  property int ads: 0
  property int trackers: 0
  property int consent: 0
  property int legal: 0
  property bool hasStats: false

  function parse(text) {
    try {
      var t = JSON.parse(text).totals || {}
      root.ads = Math.max(0, parseInt(t.ads, 10) || 0)
      root.trackers = Math.max(0, parseInt(t.trackers, 10) || 0)
      root.consent = Math.max(0, parseInt(t.consent, 10) || 0)
      root.legal = Math.max(0, parseInt(t.legal, 10) || 0)
      root.hasStats = true
    } catch (e) {
      root.hasStats = false
    }
  }

  function fmt(n) {
    return n >= 10000 ? Math.round(n / 1000) + "k" : String(n)
  }

  function openDashboard() {
    Quickshell.execDetached({
      command: [
        "/usr/bin/xdg-terminal-exec",
        "--app-id=fans.omarchy.chromium-ad-blocker",
        "--title=Chromium Ad Blocker",
        "-e",
        "/usr/bin/bash", root.cliPath, "dashboard"
      ],
      environment: { "PATH": "/usr/local/bin:/usr/bin:/bin" },
      workingDirectory: root.home
    })
  }

  FileView {
    id: statsFile
    path: root.home + "/.local/share/omarchy-adblock/stats.json"
    watchChanges: true
    printErrors: false
    onLoaded: root.parse(text())
    onFileChanged: reload()
    onLoadFailed: root.hasStats = false
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰒃"                   // nf-md-shield_check
    tooltipText: root.hasStats
      ? "Ad blocker: " + root.fmt(root.ads) + " ads, " + root.fmt(root.trackers) + " trackers, "
        + root.fmt(root.consent) + " consent, " + root.fmt(root.legal) + " legal removed"
      : "Ad blocker: nothing removed yet"
    onPressed: root.openDashboard()
  }
}
