// Tandem.app: a native window around the Tandem editor.
// On launch it uses an Tandem server already running at the configured URL (e.g. the Mac mini's launchd
// service), or starts the bundled one and stops it again on quit. Settings… points it at a remote server.
import AppKit
import WebKit

let defaultURL = "http://127.0.0.1:3290"
let dataDir = NSString(string: "~/.local/share/tandem/data").expandingTildeInPath

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var serverURL: String { UserDefaults.standard.string(forKey: "serverURL") ?? defaultURL }
    var isLocal: Bool { URL(string: serverURL).map { ["127.0.0.1", "localhost"].contains($0.host ?? "") } ?? false }

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsMagnification = false
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "Tandem"
        window.contentView = web
        window.setFrameAutosaveName("TandemMain")
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ note: Notification) {
        if let p = server, p.isRunning { p.terminate(); p.waitUntilExit() }
    }

    // MARK: server

    func start() {
        showMessage("Starting Tandem…")
        DispatchQueue.global().async {
            if self.healthy() { DispatchQueue.main.async { self.open() }; return }
            guard self.isLocal else {
                DispatchQueue.main.async { self.showMessage("Can't reach \(self.serverURL). Check the server, or change it in Tandem → Settings…") }
                return
            }
            do { try self.launchBundledServer() } catch {
                DispatchQueue.main.async { self.showMessage(error.localizedDescription) }
                return
            }
            for _ in 0..<100 { if self.healthy() { break }; Thread.sleep(forTimeInterval: 0.1) }
            DispatchQueue.main.async { self.healthy() ? self.open() : self.showMessage("The Tandem server didn't start. See ~/Library/Logs/Tandem/server.log") }
        }
    }

    func healthy() -> Bool {
        guard let url = URL(string: serverURL + "/healthz") else { return false }
        var req = URLRequest(url: url, timeoutInterval: 1.5)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            ok = (resp as? HTTPURLResponse)?.statusCode == 200 && String(data: data ?? Data(), encoding: .utf8)?.contains("tandem") == true
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return ok
    }

    func findNode() -> String? {
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "~/.local/bin/node", "~/.volta/bin/node"].map { NSString(string: $0).expandingTildeInPath }
        if let hit = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) { return hit }
        // fall back to the login shell's PATH (nvm, fnm, asdf…)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/zsh")
        p.arguments = ["-lc", "command -v node"]
        let pipe = Pipe()
        p.standardOutput = pipe
        try? p.run()
        p.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return out.isEmpty ? nil : out
    }

    func launchBundledServer() throws {
        guard let node = findNode() else {
            throw NSError(domain: "Tandem", code: 1, userInfo: [NSLocalizedDescriptionKey: "Tandem needs Node.js 20 or newer. Install it (for example: brew install node) and reopen Tandem."])
        }
        guard let script = Bundle.main.path(forResource: "server/dist/server", ofType: "js") else {
            throw NSError(domain: "Tandem", code: 2, userInfo: [NSLocalizedDescriptionKey: "This copy of Tandem.app is missing its server. Rebuild it with scripts/build-app.sh."])
        }
        let port = URL(string: serverURL)?.port ?? 3290
        let logs = NSString(string: "~/Library/Logs/Tandem").expandingTildeInPath
        try FileManager.default.createDirectory(atPath: logs, withIntermediateDirectories: true)
        let logFile = logs + "/server.log"
        if !FileManager.default.fileExists(atPath: logFile) { FileManager.default.createFile(atPath: logFile, contents: nil) }
        let log = try FileHandle(forWritingTo: URL(fileURLWithPath: logFile))
        log.seekToEndOfFile()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = [script, "serve", "--port", String(port), "--data", dataDir]
        p.standardOutput = log
        p.standardError = log
        try p.run()
        server = p
    }

    func open() {
        var target = serverURL + "/"
        if isLocal, let tok = try? String(contentsOfFile: dataDir + "/owner-token", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
           let enc = tok.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            target = serverURL + "/auth?token=" + enc
        }
        if let url = URL(string: target) { web.load(URLRequest(url: url)) }
    }

    func showMessage(_ text: String) {
        let html = "<html><body style=\"font:15px -apple-system;display:grid;place-items:center;height:90vh;color:#71717a;background:#ececee\"><p style=\"max-width:460px;text-align:center\">\(text.replacingOccurrences(of: "<", with: "&lt;"))</p></body></html>"
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: web view

    // window.open: downloads from our server are saved; anything else opens in the default browser
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = action.request.url else { return nil }
        if url.absoluteString.hasPrefix(serverURL) { webView.startDownload(using: action.request) { $0.delegate = self } }
        else { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, action.navigationType == .linkActivated, !url.absoluteString.hasPrefix(serverURL) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(disposition.contains("attachment") || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let dir = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask)[0]
        var url = dir.appendingPathComponent(suggestedFilename)
        let base = url.deletingPathExtension().lastPathComponent, ext = url.pathExtension
        var i = 2
        while FileManager.default.fileExists(atPath: url.path) { url = dir.appendingPathComponent("\(base) \(i).\(ext)"); i += 1 }
        completionHandler(url)
    }

    func downloadDidFinish(_ download: WKDownload) { NSSound(named: "Glass")?.play() }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.runModal(); completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt; a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24)); field.stringValue = defaultText ?? ""
        a.accessoryView = field
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // MARK: menu

    @objc func showSettings() {
        let a = NSAlert()
        a.messageText = "Tandem server"
        a.informativeText = "Use \(defaultURL) to run Tandem on this Mac, or enter the address of another Tandem server, such as your Mac mini's public URL."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
        field.stringValue = serverURL
        a.accessoryView = field
        a.addButton(withTitle: "Connect"); a.addButton(withTitle: "Cancel")
        guard a.runModal() == .alertFirstButtonReturn else { return }
        let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard URL(string: value)?.scheme?.hasPrefix("http") == true else { return }
        UserDefaults.standard.set(value, forKey: "serverURL")
        start()
    }

    @objc func reload() { if web.url == nil || !healthy() { start() } else { web.reload() } }
    @objc func openInBrowser() { if let u = URL(string: serverURL) { NSWorkspace.shared.open(u) } }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem(); main.addItem(appItem)
        let app = NSMenu()
        app.addItem(withTitle: "About Tandem", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        app.addItem(.separator())
        app.addItem(withTitle: "Settings…", action: #selector(showSettings), keyEquivalent: ",")
        app.addItem(.separator())
        app.addItem(withTitle: "Hide Tandem", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        app.addItem(withTitle: "Quit Tandem", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = app

        // Cut/Copy/Paste/Select All for text fields; undo stays with the page (Cmd+Z reverts your last change)
        let editItem = NSMenuItem(); main.addItem(editItem)
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit

        let viewItem = NSMenuItem(); main.addItem(viewItem)
        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        view.addItem(withTitle: "Open in Browser", action: #selector(openInBrowser), keyEquivalent: "o")
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f").keyEquivalentModifierMask = [.command, .control]
        viewItem.submenu = view

        let winItem = NSMenuItem(); main.addItem(winItem)
        let win = NSMenu(title: "Window")
        win.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        winItem.submenu = win
        NSApp.windowsMenu = win
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
