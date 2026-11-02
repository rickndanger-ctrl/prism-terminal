import Foundation

/// The one HTTP call the gateway client makes, behind a seam so tests inject a
/// deterministic stub and no real network is touched under `swift test`.
public protocol Transport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// The production transport: a plain URLSession. On device this rides the
/// private network (Tailscale) to the Mac gateway.
public struct URLSessionTransport: Transport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GatewayError.transport("Non-HTTP response")
        }
        return (data, http)
    }
}
