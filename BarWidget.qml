import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Bar button for the Chromium ad blocker. It reads the blocker's own statistics
// file for the tooltip, and a click opens a terminal showing status and
// statistics. Nothing here is looked up on PATH: the terminal is an absolute
// path, the command is this plugin's own checkout run by an absolute bash, the
// argv is fixed, and the child gets a fixed system PATH. No shell string, and
// nothing parsed but two small JSON files: the statistics the blocker writes
// and the answer of the update check.
//
// Updates (docs/update-alerts.md): lib/update.sh checks the published version
// on load and every six hours (cached, one small request to this plugin's
// repository). When a newer one is out, a dot appears on the button and the
// next click opens a small popup with what changed and an Update… button;
// Later hides that version and the click goes back to opening the dashboard.
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
  readonly property var childEnv: ({ "PATH": "/usr/local/bin:/usr/bin:/bin:/usr/share/omarchy/bin" })

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
    if (updatePopup.open) updatePopup.open = false
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

  // ---- updates ----------------------------------------------------------------
  property string version: ""
  property var updateInfo: null
  readonly property bool updateAvailable: !!updateInfo && updateInfo.update_available === true
                                          && updateInfo.dismissed !== updateInfo.latest
  readonly property bool updateMismatch: !!updateInfo && updateInfo.mismatch === true
  // What the alert is about: the newer version, or "mismatch". Update… and Later
  // hide that key only, so the next version (or a new mismatch) shows again.
  readonly property string updateKey: updateAvailable ? String(updateInfo.latest) : (updateMismatch ? "mismatch" : "")
  property string updateHiddenKey: ""
  readonly property bool updatePending: updateKey !== "" && updateKey !== updateHiddenKey

  FileView {
    path: root.pluginDir + "/manifest.json"
    printErrors: false
    onLoaded: {
      try { root.version = String(JSON.parse(text()).version || "") } catch (e) { root.version = "" }
      root.checkUpdates()
    }
  }
  function checkUpdates() {
    if (root.setting("update_check", true) === false || updateProc.running) return
    updateProc.command = ["/usr/bin/bash", root.cliPath, "update-check", root.version]
    updateProc.running = true
  }
  Process {
    id: updateProc
    environment: root.childEnv
    stdout: StdioCollector { id: updateOut; waitForEnd: true }
    onExited: function(code) { try { root.updateInfo = JSON.parse(String(updateOut.text || "")) } catch (e) { root.updateInfo = null } }
  }
  Timer { interval: 6 * 3600 * 1000; running: true; repeat: true; onTriggered: root.checkUpdates() }
  function runUpdate() {
    root.updateHiddenKey = root.updateKey
    updatePopup.open = false
    Quickshell.execDetached({
      command: ["/usr/bin/bash", root.cliPath, "update-run", root.updateAvailable ? "all" : "install"],
      environment: root.childEnv,
      workingDirectory: root.home
    })
  }
  function dismissUpdate() {
    root.updateHiddenKey = root.updateKey
    updatePopup.open = false
    if (root.updateAvailable && root.updateInfo.latest)
      Quickshell.execDetached({
        command: ["/usr/bin/bash", root.cliPath, "update-dismiss", String(root.updateInfo.latest)],
        environment: root.childEnv,
        workingDirectory: root.home
      })
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: "󰒃"                   // nf-md-shield_check
    tooltipText: (root.hasStats
      ? "Ad blocker: " + root.fmt(root.ads) + " ads, " + root.fmt(root.trackers) + " trackers, "
        + root.fmt(root.consent) + " consent, " + root.fmt(root.legal) + " legal removed"
      : "Ad blocker: nothing removed yet")
      + (root.updateAvailable ? " · " + root.updateInfo.latest + " is available" : (root.updateMismatch ? " · finish updating" : ""))
    onPressed: {
      if (root.updatePending) updatePopup.open = !updatePopup.open
      else root.openDashboard()
    }
    Rectangle {
      visible: root.updatePending
      anchors.top: parent.top; anchors.right: parent.right
      anchors.margins: Style.space(3)
      width: Style.space(6); height: width; radius: width / 2
      color: Color.accent
    }
  }

  // ---- update popup (docs/update-alerts.md) -----------------------------------
  PopupCard {
    id: updatePopup
    anchorItem: button
    bar: root.bar
    contentWidth: fittedContentWidth(Style.space(380))
    contentHeight: fittedContentHeight(updateCol.implicitHeight)
    Column {
      id: updateCol
      width: parent.width
      spacing: Style.space(4)
      Text {
        width: parent.width; wrapMode: Text.Wrap; textFormat: Text.PlainText
        text: root.updateAvailable
              ? "Chromium Ad Blocker " + root.updateInfo.latest + " is available (you have " + root.version + ")"
              : "Finish updating Chromium Ad Blocker"
        color: Color.popups.text; font.family: Style.font.family; font.pixelSize: Style.font.body; font.bold: true
      }
      Repeater {
        model: root.updateAvailable ? root.updateInfo.notes.slice(0, 4) : []
        delegate: Text {
          required property var modelData
          width: updateCol.width; wrapMode: Text.Wrap; textFormat: Text.PlainText
          text: "•  " + modelData
          color: Color.popups.text; opacity: 0.8; font.family: Style.font.family; font.pixelSize: Style.font.caption
        }
      }
      Text {
        width: parent.width; wrapMode: Text.Wrap; textFormat: Text.PlainText
        text: root.updateAvailable
              ? "Update opens a terminal: omarchy plugin update shows the changes and asks, install.sh asks, then Chromium can be restarted to load the new extension."
              : "Run install.sh once so everything matches. It asks before changing anything."
        color: Color.popups.text; opacity: 0.6; font.family: Style.font.family; font.pixelSize: Style.font.caption
      }
      Item { width: 1; height: Style.space(2) }
      Row {
        spacing: Style.space(4)
        Button { text: root.updateAvailable ? "Update…" : "Finish update…"; bordered: true; foreground: Color.accent; onClicked: root.runUpdate() }
        Button { text: "Later"; bordered: true; foreground: Color.popups.text; onClicked: root.dismissUpdate() }
        Button { text: "Open dashboard"; foreground: Color.popups.text; onClicked: root.openDashboard() }
      }
    }
  }
}
