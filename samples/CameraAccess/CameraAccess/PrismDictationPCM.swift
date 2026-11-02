import AVFoundation
import Foundation

/// Copies only live PCM frames before AVAudioEngine can reuse its tap buffer.
/// This adapter never starts audio, records to disk, or owns a recognition task.
enum PrismDictationPCM {
    struct Metadata: Sendable {
        let frameCount: Int
        let sampleRate: Double
        let byteCount: Int
        let formatID: String
        let rms: Float
    }

    private struct Layout {
        let frameCount: Int
        let bytesPerSample: Int
        let bytesPerPlane: Int
        let byteCount: Int
        let samplesPerPlane: Int
        let formatID: String
    }

    static func describe(_ buffer: AVAudioPCMBuffer) -> Metadata? {
        guard let layout = layout(of: buffer) else { return nil }
        var sum = 0.0
        let planes = readOnlyPlanes(buffer)
        for plane in planes {
            guard let data = plane.mData else { return nil }
            for index in 0..<layout.samplesPerPlane {
                let value: Double
                switch buffer.format.commonFormat {
                case .pcmFormatFloat32:
                    value = Double(data.assumingMemoryBound(to: Float.self)[index])
                case .pcmFormatFloat64:
                    value = data.assumingMemoryBound(to: Double.self)[index]
                case .pcmFormatInt16:
                    value = Double(data.assumingMemoryBound(to: Int16.self)[index]) / 32_768
                case .pcmFormatInt32:
                    value = Double(data.assumingMemoryBound(to: Int32.self)[index]) / 2_147_483_648
                default: return nil
                }
                guard value.isFinite else { return nil }
                sum += value * value
            }
        }
        let rms = sqrt(sum / Double(layout.byteCount / layout.bytesPerSample))
        guard rms.isFinite, rms <= Double(Float.greatestFiniteMagnitude) else { return nil }
        return Metadata(frameCount: layout.frameCount, sampleRate: buffer.format.sampleRate,
                        byteCount: layout.byteCount, formatID: layout.formatID, rms: Float(rms))
    }

    static func copy(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard describe(buffer) != nil, let layout = layout(of: buffer),
              let copied = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return nil }
        copied.frameLength = buffer.frameLength
        let source = readOnlyPlanes(buffer)
        let destination = UnsafeMutableAudioBufferListPointer(copied.mutableAudioBufferList)
        guard source.count == destination.count else { return nil }
        for index in source.indices {
            guard let from = source[index].mData, let to = destination[index].mData,
                  Int(destination[index].mDataByteSize) >= layout.bytesPerPlane else { return nil }
            memcpy(to, from, layout.bytesPerPlane)
            destination[index].mDataByteSize = UInt32(layout.bytesPerPlane)
        }
        return copied
    }

    private static func layout(of buffer: AVAudioPCMBuffer) -> Layout? {
        let format = buffer.format
        let description = format.streamDescription.pointee
        let frames = Int(buffer.frameLength)
        let channels = Int(format.channelCount)
        guard frames > 0, buffer.frameLength <= buffer.frameCapacity,
              channels > 0, channels <= 32, format.sampleRate.isFinite, format.sampleRate > 0,
              description.mFormatID == kAudioFormatLinearPCM,
              description.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              description.mFramesPerPacket == 1 else { return nil }
        let bytesPerSample: Int
        switch format.commonFormat {
        case .pcmFormatFloat32, .pcmFormatInt32: bytesPerSample = 4
        case .pcmFormatFloat64: bytesPerSample = 8
        case .pcmFormatInt16: bytesPerSample = 2
        default: return nil
        }
        let bytesPerFrame = bytesPerSample * (format.isInterleaved ? channels : 1)
        guard description.mBitsPerChannel == UInt32(bytesPerSample * 8),
              description.mBytesPerFrame == UInt32(bytesPerFrame),
              description.mBytesPerPacket == UInt32(bytesPerFrame) else { return nil }
        let (bytesPerPlane, planeOverflow) = frames.multipliedReportingOverflow(by: bytesPerFrame)
        let planeCount = format.isInterleaved ? 1 : channels
        let (totalBytes, totalOverflow) = bytesPerPlane.multipliedReportingOverflow(by: planeCount)
        // A tap block is normally only a few KB. Bound validation work before
        // touching arbitrary input; the handoff queue applies its tighter cap.
        guard !planeOverflow, !totalOverflow, totalBytes > 0, totalBytes <= 16 * 1024 * 1024 else { return nil }
        let planes = readOnlyPlanes(buffer)
        guard planes.count == planeCount else { return nil }
        for plane in planes {
            guard plane.mData != nil, Int(plane.mDataByteSize) >= bytesPerPlane,
                  plane.mNumberChannels == UInt32(format.isInterleaved ? channels : 1) else { return nil }
        }
        let fingerprint = [String(description.mFormatID), String(description.mFormatFlags),
                           String(format.sampleRate.bitPattern), String(description.mBytesPerPacket),
                           String(description.mFramesPerPacket), String(description.mBytesPerFrame),
                           String(description.mChannelsPerFrame), String(description.mBitsPerChannel),
                           String(format.channelLayout?.layoutTag ?? 0)].joined(separator: ":")
        return Layout(frameCount: frames, bytesPerSample: bytesPerSample,
                      bytesPerPlane: bytesPerPlane, byteCount: totalBytes,
                      samplesPerPlane: bytesPerPlane / bytesPerSample, formatID: fingerprint)
    }

    /// Swift exposes only the mutable collection wrapper, but this view is
    /// read-only in every caller. Do not use mutableAudioBufferList here: its
    /// mDataByteSize describes capacity, not the valid frameLength.
    private static func readOnlyPlanes(_ buffer: AVAudioPCMBuffer) -> UnsafeMutableAudioBufferListPointer {
        UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: buffer.audioBufferList))
    }
}
