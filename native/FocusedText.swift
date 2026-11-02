import AppKit
import ApplicationServices
import Foundation

// AX text insertion only. No keyboard events, Return/Enter, clipboard, app
// activation, menu actions, or button presses exist in this helper.
func finish(_ status: String) -> Never {
    print(status)
    exit(status == "INSERTED" ? 0 : 1)
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
    return result
}
func focused() -> AXUIElement? {
    guard let app = NSWorkspace.shared.frontmostApplication,
          let item = attribute(AXUIElementCreateApplication(app.processIdentifier), kAXFocusedUIElementAttribute),
          CFGetTypeID(item) == AXUIElementGetTypeID() else { return nil }
    return (item as! AXUIElement)
}
func selection(_ element: AXUIElement) -> CFRange? {
    guard let item = attribute(element, kAXSelectedTextRangeAttribute), CFGetTypeID(item) == AXValueGetTypeID() else { return nil }
    var range = CFRange()
    guard AXValueGetValue(item as! AXValue, .cfRange, &range) else { return nil }
    return range
}
let input = FileHandle.standardInput.readData(ofLength: 40_001)
guard input.count <= 40_000,
      let object = try? JSONSerialization.jsonObject(with: input) as? [String: String],
      object.count == 1, let text = object["text"], !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      text.utf16.count <= 8000,
      text.rangeOfCharacter(from: .controlCharacters) == nil,
      !text.contains("\u{2028}"), !text.contains("\u{2029}") else { finish("INVALID_TEXT") }
guard AXIsProcessTrusted() else { finish("ACCESSIBILITY_REQUIRED") }
guard let target = focused() else { finish("NO_EDITABLE_FIELD") }
var pid: pid_t = 0
guard AXUIElementGetPid(target, &pid) == .success,
      let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier == pid else { finish("FOCUS_CHANGED") }
let blocked = ["com.apple.Terminal", "com.googlecode.iterm2", "dev.warp.Warp-Stable",
               "com.1password.1password", "com.agilebits.onepassword7", "com.apple.keychainaccess"]
guard let bundle = app.bundleIdentifier, !blocked.contains(bundle) else { finish("UNSAFE_FIELD") }
let role = attribute(target, kAXRoleAttribute) as? String ?? ""
#if FOCUSED_DIAGNOSTICS
print("focusedRole=\(role)")
#endif
guard ["AXTextField", "AXTextArea", "AXComboBox"].contains(role) else { finish("NO_EDITABLE_FIELD") }
var ancestor = target
for _ in 0..<12 {
    let subrole = attribute(ancestor, kAXSubroleAttribute) as? String ?? ""
    if subrole.localizedCaseInsensitiveContains("secure") || subrole.localizedCaseInsensitiveContains("password") ||
        (attribute(ancestor, "AXProtectedContent") as? Bool) == true { finish("UNSAFE_FIELD") }
    guard let parent = attribute(ancestor, kAXParentAttribute), CFGetTypeID(parent) == AXUIElementGetTypeID() else { break }
    ancestor = parent as! AXUIElement
}
var settable: DarwinBoolean = false
#if FOCUSED_DIAGNOSTICS
let diagnosticStatus = AXUIElementIsAttributeSettable(target, kAXSelectedTextAttribute as CFString, &settable)
print("role=\(role) writable=\(settable.boolValue) status=\(diagnosticStatus.rawValue) selectionLength=\(selection(target)?.length ?? -1) hasValue=\(attribute(target, kAXValueAttribute) is String)")
exit(0)
#endif
guard AXUIElementIsAttributeSettable(target, kAXSelectedTextAttribute as CFString, &settable) == .success, settable.boolValue,
      let before = attribute(target, kAXValueAttribute) as? String,
      before.utf16.count <= 100_000, let range = selection(target),
      range.location >= 0, range.location <= before.utf16.count, range.length == 0 else { finish("UNSUPPORTED_FIELD") }
guard let current = focused(), CFEqual(current, target),
      NSWorkspace.shared.frontmostApplication?.processIdentifier == pid,
      attribute(target, kAXValueAttribute) as? String == before,
      let currentRange = selection(target), currentRange.location == range.location, currentRange.length == 0 else { finish("FOCUS_CHANGED") }
let expected = (before as NSString).replacingCharacters(in: NSRange(location: range.location, length: 0), with: text)
guard AXUIElementSetAttributeValue(target, kAXSelectedTextAttribute as CFString, text as CFString) == .success else { finish("INSERTION_UNVERIFIED") }
// Readback only. Failure after a write must never trigger a second insertion.
for _ in 0..<10 {
    if attribute(target, kAXValueAttribute) as? String == expected { finish("INSERTED") }
    Thread.sleep(forTimeInterval: 0.03)
}
finish("INSERTION_UNVERIFIED")
