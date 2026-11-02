import Foundation
import Security
import LocalAuthentication

// Dedicated login-Keychain slot. No caller-supplied service/account or path.
// Never pass credential data in argv, log it, or fall back to a plaintext file.
#if GMAIL_KEYCHAIN_TEST_SLOT
let service = "com.codex-lens.gateway.gmail.oauth.acceptance-test"
#else
let service = "com.codex-lens.gateway.gmail.oauth"
#endif
let account = "default"
let limit = 65_536

func emit(_ object: [String: Any], exitCode: Int32 = 0) -> Never {
    if let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    exit(exitCode)
}

func validGrant(_ data: Data) -> [String: Any]? {
    guard data.count <= limit,
          let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(value.keys) == Set(["accessToken", "refreshToken", "expiresAt", "scopes"]),
          let access = value["accessToken"] as? String,
          let refresh = value["refreshToken"] as? String,
          let expiry = value["expiresAt"] as? NSNumber,
          CFGetTypeID(expiry) != CFBooleanGetTypeID(), expiry.doubleValue.isFinite, expiry.doubleValue >= 0,
          let scopes = value["scopes"] as? [String], !scopes.isEmpty, scopes.count <= 50,
          scopes.allSatisfy({ !$0.isEmpty && $0.count <= 512 }) else { return nil }
    for token in [access, refresh] {
        guard !token.isEmpty, token.utf8.count <= 8192,
              token.utf8.allSatisfy({ $0 > 32 && $0 < 127 }) else { return nil }
    }
    return value
}

guard CommandLine.arguments.count == 2,
      ["read", "write", "delete"].contains(CommandLine.arguments[1]) else {
    emit(["status": "invalid_request"], exitCode: 2)
}
let operation = CommandLine.arguments[1]
// Fail rather than opening an unexpected permission/unlock dialog in a worker.
let authentication = LAContext()
authentication.interactionNotAllowed = true
let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: service,
    kSecAttrAccount as String: account,
    kSecAttrSynchronizable as String: false,
    kSecUseAuthenticationContext as String: authentication,
]

if operation == "read" {
    var lookup = query
    lookup[kSecReturnData as String] = true
    lookup[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(lookup as CFDictionary, &result)
    if status == errSecItemNotFound { emit(["status": "missing"]) }
    guard status == errSecSuccess else { emit(["status": "keychain_error", "code": status], exitCode: 1) }
    guard let data = result as? Data, let grant = validGrant(data) else {
        emit(["status": "invalid_data"], exitCode: 1)
    }
    emit(["status": "ok", "value": grant])
}

if operation == "delete" {
    let status = SecItemDelete(query as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
        emit(["status": "keychain_error", "code": status], exitCode: 1)
    }
    emit(["status": "ok"])
}

var data = Data()
do {
    while let chunk = try FileHandle.standardInput.read(upToCount: 8192), !chunk.isEmpty {
        data.append(chunk)
        if data.count > limit { emit(["status": "invalid_request"], exitCode: 2) }
    }
} catch { emit(["status": "invalid_request"], exitCode: 2) }
guard let grant = validGrant(data), let canonical = try? JSONSerialization.data(withJSONObject: grant),
      canonical.count <= limit else {
    emit(["status": "invalid_request"], exitCode: 2)
}
var status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: canonical] as CFDictionary)
if status == errSecItemNotFound {
    var insertion = query
    insertion[kSecValueData as String] = canonical
    insertion[kSecAttrLabel as String] = "Codex Lens Gmail authorization"
    status = SecItemAdd(insertion as CFDictionary, nil)
}
guard status == errSecSuccess else { emit(["status": "keychain_error", "code": status], exitCode: 1) }
emit(["status": "ok"])
