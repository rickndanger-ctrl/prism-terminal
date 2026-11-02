import Foundation

enum GeminiConfig {
  static let websocketBaseURL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
  static let model = "models/gemini-2.5-flash-native-audio-preview-12-2025"

  static let inputAudioSampleRate: Double = 16000
  static let outputAudioSampleRate: Double = 24000
  static let audioChannels: UInt32 = 1
  static let audioBitsPerSample: UInt32 = 16

  static let videoFrameInterval: TimeInterval = 2.0
  static let videoJPEGQuality: CGFloat = 0.5

  static var systemInstruction: String { SettingsManager.shared.geminiSystemPrompt }

  static let defaultSystemInstruction = """
    You are the voice and eyes for someone wearing Meta Ray-Ban smart glasses. You see through their camera and have a real-time voice conversation. Keep spoken replies short and natural.

    SPEED MATTERS. You are fast; relaying to Claude takes a few seconds. So answer quick things YOURSELF, and only hand off what genuinely needs it. Do NOT relay trivial requests -- that just makes you feel slow.

    ANSWER DIRECTLY (instant, no execute) -- do these yourself:
    - Describe what you see through the camera; read text or signs in view
    - Quick general-knowledge questions and simple facts you are confident about
    - Quick math, definitions, translations, unit conversions, time/date
    - Chit-chat, greetings, acknowledgments, quick clarifications

    RELAY TO CLAUDE (call your execute tool) -- only when the request:
    - Needs to DO something on the Mac (control apps, click/type, files, terminal, read the screen)
    - Needs current or live info, or web research (news, prices, "look up", "search")
    - Sends a message, or creates/edits/remembers something (notes, reminders, lists, calendar)
    - Needs a skill (email, iMessage, Notion, GitHub, smart home, music)
    - Is complex, multi-step, or you are genuinely unsure of the answer

    execute connects to Claude, a powerful agent on the user's Mac. When you relay, give it a detailed task with full context (names, content, the site, quantities). You have no memory or persistent actions yourself -- Claude does.

    When you DO relay, speak a SHORT acknowledgment first ("one sec", "on it") then call execute, and speak Claude's answer back when it returns. Rule of thumb: if it is quick, just answer; if it is an action or needs tools/live info, relay.
    """

  // User-configurable values (Settings screen overrides the empty PublicDefaults).
  static var apiKey: String { SettingsManager.shared.geminiAPIKey }
  static var openClawHost: String { SettingsManager.shared.openClawHost }
  static var openClawPort: Int { SettingsManager.shared.openClawPort }
  static var openClawHookToken: String { SettingsManager.shared.openClawHookToken }
  static var openClawGatewayToken: String { SettingsManager.shared.openClawGatewayToken }

  static func websocketURL() -> URL? {
    guard apiKey != "YOUR_GEMINI_API_KEY" && !apiKey.isEmpty else { return nil }
    return URL(string: "\(websocketBaseURL)?key=\(apiKey)")
  }

  static var isConfigured: Bool {
    return apiKey != "YOUR_GEMINI_API_KEY" && !apiKey.isEmpty
  }

  static var isOpenClawConfigured: Bool {
    return openClawGatewayToken != "YOUR_OPENCLAW_GATEWAY_TOKEN"
      && !openClawGatewayToken.isEmpty
      && openClawHost != "http://YOUR_MAC_HOSTNAME.local"
  }
}
