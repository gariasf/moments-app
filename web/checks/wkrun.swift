// Opens a check page in the system WebKit, Safari's engine, until killed or [seconds] pass.
// usage: wkrun <url> [seconds]
import AppKit
import WebKit

let url = URL(string: CommandLine.arguments[1])!
let seconds = Double(CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "300")!
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)  // never activated, so it never takes focus (.accessory does)

let config = WKWebViewConfiguration()
config.mediaTypesRequiringUserActionForPlayback = .audio  // muted playback only: sound needs a gesture
config.websiteDataStore = .nonPersistent()
let rect = NSRect(x: 40, y: 40, width: 520, height: 340)
let web = WKWebView(frame: rect, configuration: config)
let window = NSWindow(contentRect: rect, styleMask: [.titled], backing: .buffered, defer: false)
window.title = "Moments browser check (muted, closes itself)"
window.contentView = web
window.level = .floating  // kept visible: WebKit throttles hidden pages
window.orderFrontRegardless()
web.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + seconds) { exit(1) }

// A hidden window, under a locked or sleeping screen say, would get the page throttled until it
// times out, so it ends the run with the reason instead.
func endIfHidden() {
    if !window.occlusionState.contains(.visible) {
        FileHandle.standardError.write(Data("the window is hidden: is the screen locked or asleep?\n".utf8))
        exit(2)
    }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
    endIfHidden()
    NotificationCenter.default.addObserver(
        forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main
    ) { _ in MainActor.assumeIsolated { endIfHidden() } }
}
app.run()
