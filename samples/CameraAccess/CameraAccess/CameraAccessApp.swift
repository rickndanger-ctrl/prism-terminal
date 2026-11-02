/*
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the
 * LICENSE file in the root directory of this source tree.
 */

//
// CameraAccessApp.swift
//
// Main entry point for the CameraAccess sample app demonstrating the Meta Wearables DAT SDK.
// This app shows how to connect to wearable devices (like Ray-Ban Meta smart glasses),
// stream live video from their cameras, and capture photos. It provides a complete example
// of DAT SDK integration including device registration, permissions, and media streaming.
//

import Foundation
import MWDATCore
import SwiftUI

#if canImport(MWDATMockDevice)
import MWDATMockDevice
#endif

@MainActor
private final class PrismWearablesState: ObservableObject {
  let wearables: WearablesInterface?
  let viewModel: WearablesViewModel?
  let configurationError: String?

  init() {
    #if DEBUG
    if ProcessInfo.processInfo.environment["PRISM_UI_PREVIEW"] == "1" {
      wearables = nil; viewModel = nil; configurationError = nil
      return
    }
    #endif
    do {
      try Wearables.configure()
      UserDefaults.standard.set("ready", forKey: "prismWearablesSetup")
      let instance = Wearables.shared
      wearables = instance
      viewModel = WearablesViewModel(wearables: instance)
      configurationError = nil
    } catch {
      // Accessing Wearables.shared after a failed configure call traps inside
      // the SDK. Text chat must remain available when glasses setup fails.
      wearables = nil; viewModel = nil
      configurationError = "Glasses setup is unavailable: \(error.localizedDescription)"
      UserDefaults.standard.set(String(describing: error), forKey: "prismWearablesSetup")
    }
  }
}

@main
struct CameraAccessApp: App {
  @StateObject private var connection = PrismWearablesState()
  #if canImport(MWDATMockDevice)
  @StateObject private var debugMenuViewModel = DebugMenuViewModel(mockDeviceKit: MockDeviceKit.shared)
  #endif

  init() {
    #if DEBUG
    // Local device builds can be paired without embedding the runner secret in
    // source or making the user retype it. Xcode/devicectl supplies this only
    // for the launch that installs the development build.
    let launchEnvironment = ProcessInfo.processInfo.environment
    if let address = launchEnvironment["PRISM_CODEX_GATEWAY_URL"], URL(string: address)?.scheme == "https" {
      UserDefaults.standard.set(address, forKey: "prismCodexURL")
    }
    if let token = launchEnvironment["PRISM_CODEX_GATEWAY_TOKEN"], !token.isEmpty {
      do {
        try PrismCodexBridge.saveToken(token)
        UserDefaults.standard.removeObject(forKey: "prismConnectionSetupError")
      } catch {
        UserDefaults.standard.set("Mac connection could not be saved (\((error as NSError).code)).", forKey: "prismConnectionSetupError")
      }
    }
    if let secret = launchEnvironment["MOA_BRIDGE_SECRET"], !secret.isEmpty {
      UserDefaults.standard.set(secret, forKey: "bridgeSecret")
    }
    if let runnerURL = launchEnvironment["MOA_RUNNER_URL"],
       URL(string: runnerURL) != nil {
      UserDefaults.standard.set(runnerURL, forKey: "jobRunnerURL")
    }
    #endif

  }

  var body: some Scene {
    WindowGroup {
      if let wearables = connection.wearables, let viewModel = connection.viewModel {
        MainAppView(wearables: wearables, viewModel: viewModel)
          #if canImport(MWDATMockDevice)
          .sheet(isPresented: $debugMenuViewModel.showDebugMenu) {
            MockDeviceKitView(viewModel: debugMenuViewModel.mockDeviceKitViewModel)
          }
          .overlay { DebugMenuView(debugMenuViewModel: debugMenuViewModel) }
          #endif
          .alert("Error", isPresented: Binding(get: { viewModel.showError }, set: { viewModel.showError = $0 })) {
            Button("OK") { viewModel.dismissError() }
          } message: { Text(viewModel.errorMessage) }
        RegistrationView(viewModel: viewModel)
      } else {
        MoARootView(latestFrameJPEG: nil, cameraSource: "glasses", cameraConnected: false)
          .safeAreaInset(edge: .top) {
            if let message = connection.configurationError {
              Text(message).font(.caption).foregroundStyle(.secondary).padding(8)
            }
          }
      }
    }
  }
}
