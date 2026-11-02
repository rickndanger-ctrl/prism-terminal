/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

import CoreMedia
import VideoToolbox

enum DecoderError: Error {
  case invalidFormat
  case configurationError(OSStatus)
  case decodingFailed(OSStatus)
  case queueFull
}

/// Decodes compressed video frames (H.264/HEVC) into raw pixel buffers
/// using VTDecompressionSession. Used for background frame processing
/// where VideoToolbox GPU rendering is unavailable but decompression still works.
final class VideoDecoder: @unchecked Sendable {

  struct DecodedFrame {
    let pixelBuffer: CVPixelBuffer
    let presentationTimeStamp: CMTime
    let duration: CMTime
    let generation: Int
  }

  private var decompressionSession: VTDecompressionSession?
  private var currentFormatDescription: CMFormatDescription?
  private var onFrameDecoded: ((DecodedFrame) -> Void)?
  private var currentGeneration = 0
  private let queue = DispatchQueue(label: "prism.video.decode", qos: .utility)
  private let slots = DispatchSemaphore(value: 3)

  init() {}

  deinit {
    invalidateSessionOnQueue()
  }

  func setFrameCallback(_ callback: @escaping (DecodedFrame) -> Void) {
    onFrameDecoded = callback
  }

  func decode(_ sampleBuffer: CMSampleBuffer, generation: Int, onError: @escaping (Error) -> Void) {
    guard slots.wait(timeout: .now()) == .success else {
      // Missing HEVC references require a clean decoder before later frames.
      invalidateSession(); onError(DecoderError.queueFull); return
    }
    queue.async { [self] in
      defer { slots.signal() }
      do { try decodeOnQueue(sampleBuffer, generation: generation) }
      catch { invalidateSessionOnQueue(); onError(error) }
    }
  }

  private func decodeOnQueue(_ sampleBuffer: CMSampleBuffer, generation: Int) throws {
    currentGeneration = generation
    guard let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) else {
      throw DecoderError.invalidFormat
    }

    if let currentFormat = currentFormatDescription,
      !CMFormatDescriptionEqual(currentFormat, otherFormatDescription: formatDescription)
    {
      try recreateDecompressionSession(formatDescription: formatDescription)
    } else if decompressionSession == nil {
      try createDecompressionSession(formatDescription: formatDescription)
    }

    guard let session = decompressionSession else {
      throw DecoderError.invalidFormat
    }

    var flagOut = VTDecodeInfoFlags(rawValue: 0)
    let result = VTDecompressionSessionDecodeFrame(
      session,
      sampleBuffer: sampleBuffer,
      flags: [._1xRealTimePlayback],
      frameRefcon: nil,
      infoFlagsOut: &flagOut
    )

    guard result == noErr else {
      throw DecoderError.decodingFailed(result)
    }

    VTDecompressionSessionWaitForAsynchronousFrames(session)
  }

  func invalidateSession() {
    queue.async { [self] in invalidateSessionOnQueue() }
  }

  private func invalidateSessionOnQueue() {
    if let session = decompressionSession {
      VTDecompressionSessionInvalidate(session)
      decompressionSession = nil
      currentFormatDescription = nil
    }
  }

  private func recreateDecompressionSession(formatDescription: CMFormatDescription) throws {
    invalidateSessionOnQueue()
    try createDecompressionSession(formatDescription: formatDescription)
  }

  private func createDecompressionSession(formatDescription: CMFormatDescription) throws {
    let attrs: [CFString: Any] = [
      kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
      kCVPixelBufferIOSurfacePropertiesKey: NSDictionary(),
    ]

    var outputCallback = VTDecompressionOutputCallbackRecord()
    outputCallback.decompressionOutputCallback = { refcon, _, status, _, imageBuffer, presentationTimeStamp, duration in
      guard status == noErr, let imageBuffer, let refcon else {
        return
      }

      let decoder = Unmanaged<VideoDecoder>.fromOpaque(refcon).takeUnretainedValue()
      let frame = DecodedFrame(
        pixelBuffer: imageBuffer,
        presentationTimeStamp: presentationTimeStamp,
        duration: duration,
        generation: decoder.currentGeneration
      )
      decoder.onFrameDecoded?(frame)
    }
    outputCallback.decompressionOutputRefCon = Unmanaged.passUnretained(self).toOpaque()

    var session: VTDecompressionSession?
    let status = VTDecompressionSessionCreate(
      allocator: kCFAllocatorDefault,
      formatDescription: formatDescription,
      decoderSpecification: [kVTVideoDecoderSpecification_EnableHardwareAcceleratedVideoDecoder: false] as CFDictionary,
      imageBufferAttributes: attrs as CFDictionary,
      outputCallback: &outputCallback,
      decompressionSessionOut: &session
    )

    guard let session, status == noErr else {
      throw DecoderError.configurationError(status)
    }

    decompressionSession = session
    currentFormatDescription = formatDescription

    let subType = CMFormatDescriptionGetMediaSubType(formatDescription)
    let subTypeStr = String(format: "%c%c%c%c",
                            (subType >> 24) & 0xFF,
                            (subType >> 16) & 0xFF,
                            (subType >> 8) & 0xFF,
                            subType & 0xFF)
    NSLog("[VideoDecoder] Created decompression session for codec: %@", subTypeStr)
  }
}
