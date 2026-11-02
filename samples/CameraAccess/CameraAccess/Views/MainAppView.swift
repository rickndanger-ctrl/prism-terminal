/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// MainAppView.swift
//
// Central navigation hub that displays different views based on DAT SDK registration and device states.
// When unregistered, shows the registration flow. When registered, shows the device selection screen
// for choosing which Meta wearable device to stream from.
//

import MWDATCore
import MWDATCamera
import SwiftUI

struct MainAppView: View {
  let wearables: WearablesInterface
  @ObservedObject private var viewModel: WearablesViewModel
  @AppStorage("prismCameraSource") private var cameraSource = "glasses"
  @State private var showPairing = false
  @StateObject private var session = MoARealtimeSession()

  init(wearables: WearablesInterface, viewModel: WearablesViewModel) {
    self.wearables = wearables
    self.viewModel = viewModel
  }

  var body: some View {
    #if DEBUG
    if ProcessInfo.processInfo.environment["PRISM_UI_PREVIEW"] == "1" {
      MoARootView(latestFrameJPEG: nil, cameraSource: "glasses", cameraConnected: false, session: session)
    } else {
      appContent
    }
    #else
    appContent
    #endif
  }

  @ViewBuilder private var appContent: some View {
    if viewModel.registrationState == .registered || viewModel.hasMockDevice || viewModel.skipToIPhoneMode || cameraSource == "iphone" {
      MoAHostView(wearables: wearables, useIPhoneCamera: viewModel.skipToIPhoneMode || cameraSource == "iphone", session: session)
    } else {
      MoARootView(latestFrameJPEG: nil, cameraSource: "glasses", cameraConnected: false,
                  onConnectGlasses: { showPairing = true }, session: session)
        .sheet(isPresented: $showPairing) { HomeScreenView(viewModel: viewModel) }
    }
  }
}

/// Keeps VisionClaw's camera pipeline alive while the MoA UI owns the phone
/// experience. This intentionally never creates `GeminiSessionViewModel`, so
/// frames are available to MoA without starting Gemini's socket or audio path.
struct MoAHostView: View {
  let session: MoARealtimeSession
  @StateObject private var stream: StreamSessionViewModel
  @State private var cameraAttempt = 0
  @State private var snapshotRequested = false
  @State private var snapshotBusy = false
  @State private var continuousCameraRequested = false
  @State private var cameraRequestKey = ""
  @State private var cameraRequestTask: Task<Void, Never>?
  @AppStorage("prismCameraSource") private var cameraSource = "glasses"
  @AppStorage("prismGlassesQuality") private var glassesQuality = "medium"

  init(wearables: WearablesInterface, useIPhoneCamera: Bool, session: MoARealtimeSession) {
    self.session = session
    self._stream = StateObject(wrappedValue: StreamSessionViewModel(wearables: wearables))
    if useIPhoneCamera {
      UserDefaults.standard.set("iphone", forKey: "prismCameraSource")
    }
  }

  var body: some View {
    MoARootView(
      latestFrameJPEG: stream.currentFrameJPEG,
      latestFrameAt: stream.currentFrameAt,
      readCameraFrame: { [stream] in
        guard let data = stream.currentFrameJPEG else { return nil }
        return (data, stream.currentFrameAt)
      },
      cameraSource: cameraSource,
      cameraConnected: stream.hasReceivedFirstFrame && stream.streamingStatus == .streaming,
      onConnectGlasses: { cameraAttempt += 1 }, session: session,
      cameraStatus: stream.errorMessage.isEmpty
        ? (snapshotRequested || continuousCameraRequested ? stream.cameraStatus : stream.hasActiveDevice || cameraSource == "iphone" ? "Camera ready" : "Waiting for glasses")
        : stream.errorMessage,
      cameraActionLabel: "Camera", captureSnapshot: captureSnapshot,
      onContinuousCameraChanged: { enabled in
        continuousCameraRequested = enabled
        reconcileCameraRequest()
      }
    )
    .task(id: cameraSource + ":" + glassesQuality + ":" + (cameraSource == "glasses" ? String(stream.hasActiveDevice) : "iphone") + ":" + String(cameraAttempt) + ":" + String(snapshotRequested || continuousCameraRequested)) {
      reconcileCameraRequest()
    }
  }

  /// Imperative lifecycle also runs while SwiftUI is not rendering under lock.
  @MainActor private func reconcileCameraRequest() {
    let requested = snapshotRequested || continuousCameraRequested
    let key = "\(cameraSource):\(glassesQuality):\(stream.hasActiveDevice):\(cameraAttempt):\(requested)"
    guard key != cameraRequestKey else { return }
    cameraRequestKey = key
    let previous = cameraRequestTask
    previous?.cancel()
    cameraRequestTask = Task {
      // Stop must not wait for a non-cooperative SDK start/permission await.
      if requested { await previous?.value }
      guard !Task.isCancelled else { return }
      await stream.stopSession()
      guard !Task.isCancelled, requested else { return }
      if cameraSource == "iphone" { await stream.handleStartIPhone() }
      else {
        guard stream.hasActiveDevice else { return }
        let resolution: StreamingResolution = glassesQuality == "high" ? .high
          : glassesQuality == "low" ? .low : .medium
        stream.updateResolution(resolution)
        await stream.handleStartStreaming()
      }
    }
  }

  /// A short camera session supplies one new frame. Chat stays interactive and
  /// the normal SDK capture indicator remains under the glasses' control.
  @MainActor private func captureSnapshot() async -> Data? {
    guard !snapshotBusy else { return nil }
    snapshotBusy = true
    defer { snapshotBusy = false; snapshotRequested = false; reconcileCameraRequest() }
    stream.dismissError()
    let requestedAt = Date()
    snapshotRequested = true
    reconcileCameraRequest()
    let deadline = requestedAt.addingTimeInterval(15)
    var result: Data?
    while !Task.isCancelled, Date() < deadline {
      if stream.streamingStatus == .streaming, stream.currentFrameAt > requestedAt,
         let frame = stream.currentFrameJPEG {
        result = frame
        break
      }
      if stream.showError { break }
      do { try await Task.sleep(for: .milliseconds(50)) } catch { break }
    }
    snapshotRequested = false
    reconcileCameraRequest()
    let stopDeadline = Date().addingTimeInterval(3)
    while !continuousCameraRequested, stream.streamingStatus != .stopped, Date() < stopDeadline {
      do { try await Task.sleep(for: .milliseconds(50)) } catch { break }
    }
    return Task.isCancelled ? nil : result
  }
}
