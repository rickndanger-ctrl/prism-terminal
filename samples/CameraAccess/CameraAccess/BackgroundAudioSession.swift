//
//  BackgroundAudioSession.swift
//  VisionClaw-MoA
//
//  Keeps the app alive while backgrounded by holding an active audio session.
//  Requires the "Audio, AirPlay, and Picture in Picture" Background Mode capability.
//  NOTE: this keeps the app running when BACKGROUNDED (off-screen), not after a
//  force-quit — no third-party iOS app can survive a force-quit.
//

import AVFoundation

final class BackgroundAudioSession {
    static let shared = BackgroundAudioSession()
    private init() {}

    func begin() {
        let session = AVAudioSession.sharedInstance()
        do {
            // playAndRecord so we can both capture speech and speak replies through
            // the glasses/phone; mixWithOthers so we don't rudely kill the user's music.
            try session.setCategory(.playAndRecord,
                                    mode: .spokenAudio,
                                    options: [.defaultToSpeaker, .allowBluetooth,
                                              .allowBluetoothA2DP, .mixWithOthers])
            try session.setActive(true)
        } catch {
            NSLog("[MoA] audio session begin failed: %@", error.localizedDescription)
        }
    }

    func end() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
