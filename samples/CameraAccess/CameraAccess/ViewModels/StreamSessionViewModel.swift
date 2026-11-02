/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// StreamSessionViewModel.swift
//
// Core view model demonstrating video streaming from Meta wearable devices using the DAT SDK.
// This class showcases the key streaming patterns: device selection, session management,
// video frame handling, photo capture, and error handling.
//

import CoreImage
import CoreMedia
import CoreVideo
import MWDATCamera
import MWDATCore
import SwiftUI
import VideoToolbox

enum StreamingStatus {
  case streaming
  case waiting
  case stopped
}

enum StreamingMode {
  case glasses
  case iPhone
}

@MainActor
class StreamSessionViewModel: ObservableObject {
  @Published var currentVideoFrame: UIImage?
  @Published var currentFrameJPEG: Data?
  private(set) var currentFrameAt = Date.distantPast
  @Published var hasReceivedFirstFrame: Bool = false
  @Published var streamingStatus: StreamingStatus = .stopped
  @Published var cameraStatus = "Waiting for glasses"
  @Published var showError: Bool = false
  @Published var errorMessage: String = ""
  @Published var hasActiveDevice: Bool = false
  @Published var streamingMode: StreamingMode = .glasses
  @Published var selectedResolution: StreamingResolution = .low

  var isStreaming: Bool {
    streamingStatus != .stopped
  }

  var resolutionLabel: String {
    switch selectedResolution {
    case .low: return "360x640"
    case .medium: return "504x896"
    case .high: return "720x1280"
    @unknown default: return "Unknown"
    }
  }

  // Photo capture properties
  @Published var capturedPhoto: UIImage?
  @Published var showPhotoPreview: Bool = false

  // Gemini Live integration
  var geminiSessionVM: GeminiSessionViewModel?

  // WebRTC Live streaming integration
  var webrtcSessionVM: WebRTCSessionViewModel?

  // The core DAT SDK StreamSession - handles all streaming operations
  private var streamSession: StreamSession
  // Listener tokens are used to manage DAT SDK event subscriptions
  private var stateListenerToken: AnyListenerToken?
  private var videoFrameListenerToken: AnyListenerToken?
  private var errorListenerToken: AnyListenerToken?
  private var photoDataListenerToken: AnyListenerToken?
  private let wearables: WearablesInterface
  private let deviceSelector: AutoDeviceSelector
  private var deviceMonitorTask: Task<Void, Never>?
  private var iPhoneCameraManager: IPhoneCameraManager?

  // CPU-based CIContext for rendering decoded pixel buffers in background
  private let cpuCIContext = CIContext(options: [.useSoftwareRenderer: true])
  // VideoDecoder for decompressing HEVC/H.264 frames in background
  private let videoDecoder = VideoDecoder()
  private var backgroundFrameCount = 0
  private var bgDiagLogged = false
  private var jpegEncodeInFlight = false
  private var lastJPEGEncode = Date.distantPast
  private var jpegGeneration = 0
  private var lastBackgroundRender = Date.distantPast
  private var decodeFailures = 0

  init(wearables: WearablesInterface) {
    self.wearables = wearables
    // Let the SDK auto-select from available devices
    self.deviceSelector = AutoDeviceSelector(wearables: wearables)
    let config = StreamSessionConfig(
      videoCodec: VideoCodec.hvc1,
      resolution: StreamingResolution.low,
      frameRate: 7)
    streamSession = StreamSession(streamSessionConfig: config, deviceSelector: deviceSelector)

    // Monitor device availability
    deviceMonitorTask = Task { @MainActor in
      for await device in deviceSelector.activeDeviceStream() {
        self.hasActiveDevice = device != nil
        UserDefaults.standard.set(device != nil, forKey: "prismActiveDevice")
      }
    }

    setupVideoDecoder()
    attachListeners()
  }

  private func setupVideoDecoder() {
    videoDecoder.setFrameCallback { [weak self] decodedFrame in
      Task { @MainActor [weak self] in
        guard let self else { return }
        guard self.streamingStatus != .stopped, decodedFrame.generation == self.jpegGeneration else { return }
        if UIApplication.shared.applicationState == .background {
          let now = Date()
          guard now.timeIntervalSince(self.lastBackgroundRender) >= 1 else { return }
          self.lastBackgroundRender = now
        }
        let pixelBuffer = decodedFrame.pixelBuffer
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        if let cgImage = self.cpuCIContext.createCGImage(ciImage, from: rect) {
          let image = UIImage(cgImage: cgImage)
          self.publishFrame(image)
          self.hasReceivedFirstFrame = true
          self.geminiSessionVM?.sendVideoFrameIfThrottled(image: image)
          self.webrtcSessionVM?.pushVideoFrame(image)
          if self.backgroundFrameCount <= 5 || self.backgroundFrameCount % 120 == 0 {
            NSLog("[Stream] Background frame #%d decoded and forwarded (%dx%d)",
                  self.backgroundFrameCount, width, height)
          }
        }
      }
    }
  }

  /// Recreate the StreamSession with the current selectedResolution.
  /// Only call when not actively streaming.
  func updateResolution(_ resolution: StreamingResolution) {
    guard !isStreaming else { return }
    selectedResolution = resolution
    jpegGeneration += 1
    videoDecoder.invalidateSession()
    let config = StreamSessionConfig(
      videoCodec: VideoCodec.hvc1,
      resolution: resolution,
      frameRate: 7)
    streamSession = StreamSession(streamSessionConfig: config, deviceSelector: deviceSelector)
    attachListeners()
    NSLog("[Stream] Resolution changed to %@", resolutionLabel)
  }

  private func attachListeners() {
    let observedSession = streamSession
    // Subscribe to session state changes using the DAT SDK listener pattern
    stateListenerToken = streamSession.statePublisher.listen { [weak self] state in
      Task { @MainActor [weak self] in
        guard let self, self.streamSession === observedSession else { return }
        self.updateStatusFromState(state)
      }
    }

    // Subscribe to video frames from the device camera
    // This callback fires whether the app is in the foreground or background,
    // enabling continuous streaming even when the screen is locked.
    videoFrameListenerToken = streamSession.videoFramePublisher.listen { [weak self] videoFrame in
      Task { @MainActor [weak self] in
        guard let self, self.streamSession === observedSession, self.streamingStatus != .stopped else { return }

        // DAT 0.5 hvc1 frames continue while locked. Decode compressed buffers
        // through the same software path in both foreground and background.
        let compressed = videoFrame.sampleBuffer
        if CMSampleBufferGetDataBuffer(compressed) != nil {
          self.backgroundFrameCount += 1
          self.videoDecoder.decode(compressed, generation: self.jpegGeneration) { [weak self] error in
            Task { @MainActor [weak self] in
              guard let self, self.streamSession === observedSession else { return }
              self.decodeFailures += 1
              if self.decodeFailures <= 3 || self.decodeFailures % 120 == 0 {
                UserDefaults.standard.set(String(describing: error), forKey: "prismCameraDecodeError")
                UserDefaults.standard.set(self.decodeFailures, forKey: "prismCameraDecodeFailures")
              }
            }
          }
          return
        }

        let isInBackground = UIApplication.shared.applicationState == .background

        if !isInBackground {
          self.backgroundFrameCount = 0
          self.bgDiagLogged = false
          if let image = videoFrame.makeUIImage() {
            self.publishFrame(image)
            if !self.hasReceivedFirstFrame {
              self.hasReceivedFirstFrame = true
            }
            self.geminiSessionVM?.sendVideoFrameIfThrottled(image: image)
            self.webrtcSessionVM?.pushVideoFrame(image)
          }
        } else {
          // In background: makeUIImage() uses VideoToolbox GPU rendering which iOS suspends.
          // Instead, use our VideoDecoder (VTDecompressionSession) to decode compressed
          // frames into pixel buffers, then convert via CPU CIContext.
          self.backgroundFrameCount += 1

          let sampleBuffer = videoFrame.sampleBuffer
          let hasCompressedData = CMSampleBufferGetDataBuffer(sampleBuffer) != nil

          if hasCompressedData {
            // Compressed frame (HEVC/H.264) - decode via VTDecompressionSession
            self.videoDecoder.decode(sampleBuffer, generation: self.jpegGeneration) { _ in }
          } else if let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) {
            // Raw pixel buffer - convert directly via CPU CIContext
            let width = CVPixelBufferGetWidth(pixelBuffer)
            let height = CVPixelBufferGetHeight(pixelBuffer)
            let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
            let rect = CGRect(x: 0, y: 0, width: width, height: height)
            if let cgImage = self.cpuCIContext.createCGImage(ciImage, from: rect) {
              let image = UIImage(cgImage: cgImage)
              self.publishFrame(image)
              self.hasReceivedFirstFrame = true
              self.geminiSessionVM?.sendVideoFrameIfThrottled(image: image)
              self.webrtcSessionVM?.pushVideoFrame(image)
            }
            self.videoDecoder.invalidateSession()
          }
        }
      }
    }

    // Subscribe to streaming errors
    errorListenerToken = streamSession.errorPublisher.listen { [weak self] error in
      Task { @MainActor [weak self] in
        guard let self, self.streamSession === observedSession else { return }
        // Suppress device-not-found errors when user hasn't started streaming yet
        if self.streamingStatus == .stopped {
          if case .deviceNotConnected = error { return }
          if case .deviceNotFound = error { return }
        }
        let newErrorMessage = formatStreamingError(error)
        if newErrorMessage != self.errorMessage {
          showError(newErrorMessage)
        }
        if case .thermalCritical = error { await self.stopSession() }
      }
    }

    updateStatusFromState(streamSession.state)

    // Subscribe to photo capture events
    photoDataListenerToken = streamSession.photoDataPublisher.listen { [weak self] photoData in
      Task { @MainActor [weak self] in
        guard let self, self.streamSession === observedSession else { return }
        if let uiImage = UIImage(data: photoData.data) {
          self.capturedPhoto = uiImage
          self.showPhotoPreview = true
        }
      }
    }
  }

  func handleStartStreaming() async {
    guard hasActiveDevice else { cameraStatus = "Waiting for glasses"; return }
    cameraStatus = "Checking camera permission"
    let permission = Permission.camera
    do {
      let status = try await wearables.checkPermissionStatus(permission)
      UserDefaults.standard.set(String(describing: status), forKey: "prismCameraPermission")
      if status == .granted {
        guard !Task.isCancelled else { return }
        await startSession()
        return
      }
      let requestStatus = try await wearables.requestPermission(permission)
      UserDefaults.standard.set(String(describing: requestStatus), forKey: "prismCameraPermission")
      if requestStatus == .granted {
        guard !Task.isCancelled else { return }
        await startSession()
        return
      }
      showError("Permission denied")
    } catch {
      showError("Permission error: \(error.description)")
    }
  }

  func startSession() async {
    await streamSession.start()
  }

  private func showError(_ message: String) {
    cameraStatus = message
    UserDefaults.standard.set(message, forKey: "prismCameraError")
    errorMessage = message
    showError = true
  }

  func stopSession() async {
    jpegGeneration += 1
    currentFrameJPEG = nil
    currentFrameAt = .distantPast
    videoDecoder.invalidateSession()
    if streamingMode == .iPhone {
      stopIPhoneSession()
      return
    }
    await streamSession.stop()
  }

  // MARK: - iPhone Camera Mode

  func handleStartIPhone() async {
    let granted = await IPhoneCameraManager.requestPermission()
    if granted {
      startIPhoneSession()
    } else {
      showError("Camera permission denied. Please grant access in Settings.")
    }
  }

  private func startIPhoneSession() {
    streamingMode = .iPhone
    let camera = IPhoneCameraManager()
    camera.onFrameCaptured = { [weak self] image in
      Task { @MainActor [weak self] in
        guard let self else { return }
        self.publishFrame(image)
        if !self.hasReceivedFirstFrame {
          self.hasReceivedFirstFrame = true
        }
        self.geminiSessionVM?.sendVideoFrameIfThrottled(image: image)
        self.webrtcSessionVM?.pushVideoFrame(image)
      }
    }
    camera.start()
    iPhoneCameraManager = camera
    streamingStatus = .streaming
    NSLog("[Stream] iPhone camera mode started")
  }

  private func stopIPhoneSession() {
    iPhoneCameraManager?.stop()
    iPhoneCameraManager = nil
    currentVideoFrame = nil
    currentFrameJPEG = nil
    jpegGeneration += 1
    jpegEncodeInFlight = false
    hasReceivedFirstFrame = false
    streamingStatus = .stopped
    streamingMode = .glasses
    NSLog("[Stream] iPhone camera mode stopped")
  }

  /// Keep the full-rate UIImage available to the native preview while producing
  /// a gesture/GPT JPEG at ~5 fps off the UI path. Previously SwiftUI encoded
  /// every 24 fps frame in `body`, which caused avoidable gesture latency.
  private func publishFrame(_ image: UIImage) {
    if !hasReceivedFirstFrame {
      UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: "prismCameraFirstFrame")
    }
    currentVideoFrame = image
    let now = Date()
    guard !jpegEncodeInFlight,
          now.timeIntervalSince(lastJPEGEncode) >= 0.16 else { return }
    jpegEncodeInFlight = true
    lastJPEGEncode = now
    let generation = jpegGeneration
    Task {
      let jpeg = await Task.detached(priority: .userInitiated) {
        image.jpegData(compressionQuality: 0.55)
      }.value
      if generation == self.jpegGeneration {
        self.currentFrameAt = now
        self.currentFrameJPEG = jpeg
      }
      self.jpegEncodeInFlight = false
    }
  }

  func dismissError() {
    showError = false
    errorMessage = ""
  }

  func capturePhoto() {
    streamSession.capturePhoto(format: .jpeg)
  }

  func dismissPhotoPreview() {
    showPhotoPreview = false
    capturedPhoto = nil
  }

  private func updateStatusFromState(_ state: StreamSessionState) {
    UserDefaults.standard.set(String(describing: state), forKey: "prismCameraStreamState")
    switch state {
    case .stopped: cameraStatus = hasActiveDevice ? "Camera stopped" : "Waiting for glasses"
    case .waitingForDevice: cameraStatus = "Waiting for glasses"
    case .starting: cameraStatus = "Starting camera"
    case .stopping: cameraStatus = "Stopping camera"
    case .paused: cameraStatus = "Camera paused"
    case .streaming: cameraStatus = "Camera live"
    }
    switch state {
    case .stopped:
      currentVideoFrame = nil
      currentFrameJPEG = nil
      jpegGeneration += 1
      jpegEncodeInFlight = false
      hasReceivedFirstFrame = false
      streamingStatus = .stopped
    case .waitingForDevice, .starting, .stopping, .paused:
      streamingStatus = .waiting
    case .streaming:
      streamingStatus = .streaming
    }
  }

  private func formatStreamingError(_ error: StreamSessionError) -> String {
    switch error {
    case .internalError:
      return "An internal error occurred. Please try again."
    case .deviceNotFound:
      return "Device not found. Please ensure your device is connected."
    case .deviceNotConnected:
      return "Device not connected. Please check your connection and try again."
    case .timeout:
      return "The operation timed out. Please try again."
    case .videoStreamingError:
      return "Video streaming failed. Please try again."
    case .thermalCritical:
      return "Glasses are too warm. Stop sharing and let them cool."
    case .permissionDenied:
      return "Camera permission denied. Please grant permission in Settings."
    case .hingesClosed:
      return "The hinges on the glasses were closed. Please open the hinges and try again."
    @unknown default:
      return "An unknown streaming error occurred."
    }
  }
}
