import XCTest
@testable import CodexLensKit

final class SpokenPadCommandTests: XCTestCase {
    func testExactOpenCommands() {
        for text in ["Open Calculator", "Codex, open Calculator.", "Can you open Calculator?", "Please open Calculator"] {
            XCTAssertEqual(SpokenPadCommand.parse(text)?.action, "open")
            XCTAssertEqual(SpokenPadCommand.parse(text)?.value, "Calculator")
        }
        XCTAssertEqual(SpokenPadCommand.parse("switch to VS Code")?.value, "Visual Studio Code")
    }
    func testOptionalArticleAndBringUpUseExactAppAliases() {
        let apps = [("Calculator", "Calculator"), ("VS Code", "Visual Studio Code"),
                    ("Visual Studio Code", "Visual Studio Code"), ("Notes", "Notes"),
                    ("Settings", "System Settings"), ("System Settings", "System Settings"),
                    ("Codex", "ChatGPT"), ("Chat GPT", "ChatGPT"), ("Claude", "Claude"),
                    ("Cursor", "Cursor"), ("Google Chrome", "Google Chrome"), ("Texts", "Messages"),
                    ("Face Time", "FaceTime"), ("Text Edit", "TextEdit")]
        for prefix in ["Open ", "Open up ", "Launch ", "Switch to ", "Bring up "] {
            for article in ["", "the "] {
                for (alias, app) in apps {
                    let phrase = prefix + article + alias
                    XCTAssertEqual(SpokenPadCommand.parse(phrase), SpokenPadCommand(action: "open", value: app), phrase)
                    XCTAssertEqual(SpokenPadCommand.parse("Codex, could you please " + phrase.lowercased() + " for me, please?"),
                                   SpokenPadCommand(action: "open", value: app), phrase)
                }
            }
        }
    }

    func testExplicitCurrentWindowCloseAliases() {
        for phrase in ["Close the window", "Close window", "Close the frontmost window"] {
            XCTAssertEqual(SpokenPadCommand.parse(phrase), SpokenPadCommand(action: "close", value: ""), phrase)
            XCTAssertEqual(SpokenPadCommand.parse("Would you please " + phrase.lowercased() + " for me?"),
                           SpokenPadCommand(action: "close", value: ""), phrase)
        }
    }

    func testNewAppAliasesRejectNonexactAndUnboundRequests() {
        for phrase in ["Open the calculator and type hello", "Bring up the Calculator and Notes",
                       "Bring up the Calculator then type hello", "Switch to the Notes and send it",
                       "Open the Calculator for me and type hello", "Launch the Calculator, but not now",
                       "Don't open the Calculator", "Do not bring up the Calculator",
                       "Would you please not bring up the Calculator for me?",
                       "He said bring up the Calculator", "If I say open the Calculator",
                       "\"Open the Calculator\"", "“Bring up the Calculator”",
                       "Could you please \"bring up the Calculator\" for me?",
                       "Open the UnknownApp", "Bring up UnknownApp", "Launch the CalculatorXYZ",
                       "Bring up", "Open the", "Open the the Calculator", "Bring upCalculator",
                       "Bring the Calculator up", "Bring up https://example.com",
                       "Open the /bin/sh", "Bring up the /Applications/Calculator.app",
                       "Close the Calculator", "Close the Notes window", "Close the window in Notes",
                       "Close the frontmost window and send it", "Don't close the window",
                       "Close all windows", "Do it"] {
            XCTAssertNil(SpokenPadCommand.parse(phrase), phrase)
        }
    }

    func testNewAppWordsAndCourtesySuffixesStayLiteralInsidePayloads() {
        let payloads = ["Bring up the Calculator, please!", "Open the Notes and type hello for me?",
                        "Close the frontmost window for me, please", "Cafe\u{0301} — bring up the Notes, please!"]
        for payload in payloads {
            for (prefix, action) in [("Type ", "typeFocused"), ("Type in TextEdit ", "type"),
                                     ("Search the web for ", "search"), ("Search Google for ", "search")] {
                let command = SpokenPadCommand.parse("Could you please " + prefix + payload)
                XCTAssertEqual(command?.action, action)
                XCTAssertEqual(command.map { Array($0.value.utf8) }, Array(payload.utf8))
            }
        }
        let url = "https://Example.com/Bring%20Up/The?note=for%20me%2C%20please!"
        let command = SpokenPadCommand.parse("Could you please open the website " + url)
        XCTAssertEqual(command?.action, "navigate")
        XCTAssertEqual(command.map { Array($0.value.utf8) }, Array(url.utf8))
    }

    func testNegatedQuotedAndCompoundCommandsDoNotRunAsShortcuts() {
        for text in ["Don't open Calculator", "Do not close the current window", "He said open Calculator",
                     "\"open Calculator\"", "If I say open Calculator", "Open Calculator and send a text",
                     "Open /bin/sh", "Close Notes", "Do not type ls into Terminal", "What time is it?"] {
            XCTAssertNil(SpokenPadCommand.parse(text), text)
        }
    }
    func testPoliteFixedCommandsUseSameWhitelistedActions() {
        for text in ["Could you please open up Calculator for me?",
                     "Would you please open Calculator?", "Would you launch Calculator for me?",
                     "Open up Calculator, please", "Open up Calculator for me, please.",
                     "Codex, would you please launch Calculator for me please?"] {
            XCTAssertEqual(SpokenPadCommand.parse(text), SpokenPadCommand(action: "open", value: "Calculator"), text)
        }
        XCTAssertEqual(SpokenPadCommand.parse("Would you please switch to VS Code for me?")?.value, "Visual Studio Code")
        for text in ["Could you please close the current window for me?", "Close this window please."] {
            XCTAssertEqual(SpokenPadCommand.parse(text), SpokenPadCommand(action: "close", value: ""), text)
        }
    }
    func testPolitenessDoesNotBroadenAuthorization() {
        for text in ["Would you please not open Calculator for me?",
                     "Could you please don't close the current window for me?",
                     "Would you please open up Calculator and Notes for me?",
                     "Open Calculator for me and send a text", "Open Calculator for me, but not now",
                     "Would you please close Calculator for me?",
                     "Could you please close all windows for me?",
                     "Would you please open up /bin/sh for me?",
                     "Could you please explain open Calculator for me?",
                     "\"Would you please open Calculator for me?\"",
                     "Would you please \"open Calculator\" for me?"] {
            XCTAssertNil(SpokenPadCommand.parse(text), text)
        }
    }
    func testCourtesyWordsInsidePayloadRemainLiteral() {
        XCTAssertEqual(SpokenPadCommand.parse("Would you please type Keep this for me please")?.value, "Keep this for me please")
        XCTAssertEqual(SpokenPadCommand.parse("Could you please type in TextEdit Keep this for me?")?.value, "Keep this for me?")
        XCTAssertEqual(SpokenPadCommand.parse("Would you please search the web for open up Calculator for me?")?.value, "open up Calculator for me?")
        XCTAssertEqual(SpokenPadCommand.parse("Would you type open Calculator and send it for me")?.action, "typeFocused")
        XCTAssertEqual(SpokenPadCommand.parse("Would you type open Calculator and send it for me")?.value, "open Calculator and send it for me")
    }
    func testLiteralPayloadAndBoundaries() {
        XCTAssertEqual(SpokenPadCommand.parse("Type hello and send")?.action, "typeFocused")
        XCTAssertEqual(SpokenPadCommand.parse("Type hello and send")?.value, "hello and send")
        XCTAssertEqual(SpokenPadCommand.parse("Codex, type Hello world!")?.value, "Hello world!")
        XCTAssertEqual(SpokenPadCommand.parse("Type in TextEdit hello world")?.value, "hello world")
        XCTAssertEqual(SpokenPadCommand.parse("Type in a new TextEdit document: Hello!\nKeep punctuation.")?.value, "Hello!\nKeep punctuation.")
        XCTAssertEqual(SpokenPadCommand.parse("Search the web for coffee & tea")?.value, "coffee & tea")
        XCTAssertNil(SpokenPadCommand.parse("Search the web for " + String(repeating: "a", count: 1001)))
        XCTAssertNil(SpokenPadCommand.parse("Open Calculator\0"))
        XCTAssertEqual(SpokenPadCommand.parse("Close the current window.")?.action, "close")
    }

    func testInstalledAppAliasesKeepExecutableIdentity() {
        XCTAssertEqual(SpokenPadCommand.parse("Open Safari"), SpokenPadCommand(action: "open", value: "Safari"))
        // The command pad uses ChatGPT as its canonical app alias for Codex.
        XCTAssertEqual(SpokenPadCommand.parse("Open Codex"), SpokenPadCommand(action: "open", value: "ChatGPT"))
        XCTAssertEqual(SpokenPadCommand.parse("Switch to ChatGPT"), SpokenPadCommand(action: "open", value: "ChatGPT"))
    }

    func testBoundedWindowActions() {
        let examples = [
            "Minimize this window": "minimize", "Minimize the current window": "minimize",
            "Maximize this window": "maximize", "Maximize the current window": "maximize",
            "Move this window left": "left", "Move this window right": "right",
            "Move this window to the left": "left", "Put the window on the left half": "left",
            "Snap this window left": "left", "Tile the current window left": "left",
            "Move the current window to the right half": "right", "Snap window right": "right"
        ]
        for (phrase, value) in examples {
            XCTAssertEqual(SpokenPadCommand.parse(phrase), SpokenPadCommand(action: "window", value: value), phrase)
            XCTAssertEqual(SpokenPadCommand.parse("Codex, could you please \(phrase.lowercased()) for me?"),
                           SpokenPadCommand(action: "window", value: value), phrase)
        }
    }

    func testBoundedBrowserActions() {
        let examples = [
            "Go back a page": "back", "Go back in the browser": "back",
            "Go forward one page": "forward", "Browser forward": "forward",
            "Reload this page": "reload", "Refresh the page": "reload",
            "Open a new tab": "newTab", "New tab": "newTab",
            "Switch to the next tab": "nextTab", "Next tab": "nextTab",
            "Go to the previous tab": "previousTab", "Previous tab": "previousTab",
            "Close this tab": "closeTab", "Close the current tab": "closeTab",
            "Focus the address bar": "focusAddress", "Go to the address bar": "focusAddress"
        ]
        for (phrase, value) in examples {
            XCTAssertEqual(SpokenPadCommand.parse(phrase), SpokenPadCommand(action: "browser", value: value), phrase)
            XCTAssertEqual(SpokenPadCommand.parse("Would you please \(phrase.lowercased()), please."),
                           SpokenPadCommand(action: "browser", value: value), phrase)
        }
    }

    func testNewActionsDoNotGuessScopeOrExecuteCompoundRequests() {
        for phrase in ["Go back", "Go forward", "Restore everything", "Restore the window", "Unminimize the front window",
                       "Close all tabs", "Minimize all windows",
                       "Maximize Notes", "Move this window to another screen", "Go full screen",
                       "Don't refresh the page", "Please don't open a new tab", "Open a new tab and type hello",
                       "Close this tab then close Chrome", "If I say minimize this window", "He said next tab",
                       "\"Next tab\"", "“Close this tab”", "Put the window on the left half and send it",
                       "Press Enter", "Press return", "Send it", "Run it", "Click yes", "Open Safari and Notes"] {
            XCTAssertNil(SpokenPadCommand.parse(phrase), phrase)
        }
    }

    func testExplicitNavigationPreservesLiteralURLContents() {
        let url = "https://Example.com/ReadMe?q=Keep!&sort=DESC#PartTwo"
        for prefix in ["Go to ", "Navigate to ", "Open the website ", "Open website ", "Open the URL ",
                       "Open URL ", "Visit ", "Open "] {
            XCTAssertEqual(SpokenPadCommand.parse(prefix + url), SpokenPadCommand(action: "navigate", value: url), prefix)
        }
        XCTAssertEqual(SpokenPadCommand.parse("Codex, could you please go to example.com/ReadMe?q=Keep!"),
                       SpokenPadCommand(action: "navigate", value: "https://example.com/ReadMe?q=Keep!"))
        XCTAssertEqual(SpokenPadCommand.parse("Go to http://localhost:3000/Preview")?.value, "http://localhost:3000/Preview")
        XCTAssertEqual(SpokenPadCommand.parse("Go to localhost:3000/Preview")?.value, "https://localhost:3000/Preview")
        XCTAssertEqual(SpokenPadCommand.parse("Go to 192.168.1.10:8080/test")?.value, "https://192.168.1.10:8080/test")
        XCTAssertEqual(SpokenPadCommand.parse("Open https://example.com/a%20b?x=1")?.value, "https://example.com/a%20b?x=1")
    }

    func testUnsafeAndAmbiguousNavigationDoesNotFastRoute() {
        for target in ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,hello", "mailto:user@example.com",
                       "codex://thread/123", "https://user:password@example.com/", "https://user@example.com/",
                       "https://example.com/a\\b", "https://example.com/\"test\"", "https://example.com/'test'",
                       "https://example.com/`test`", "https://example.com/<test>", "https://example.com/a\nb",
                       "https://example.com/a%0Ab", "https://example.com/a%00b", "https://example.com/%GG",
                       "https://example.com then send a text", "example.com and open Notes", "example.com please",
                       "/Applications/Notes.app", "unknownapp", "https://-example.com", "https://example..com",
                       "https://999.999.999.999", "https://127.1", "https://example.com:65536",
                       "https://example.com:0", "https://example.com:99999999999999999999"] {
            XCTAssertNil(SpokenPadCommand.parse("Go to " + target), target)
        }
        for phrase in ["Don't go to example.com", "If I say go to example.com", "He said go to example.com",
                       "\"Go to example.com\"", "Open the website \"example.com\"", "Go to example dot com"] {
            XCTAssertNil(SpokenPadCommand.parse(phrase), phrase)
        }
        XCTAssertNil(SpokenPadCommand.parse("Go to https://example.com/" + String(repeating: "x", count: 2048)))
    }

    func testNewShortcutWordsInsideTypingAndSearchStayLiteral() {
        for payload in ["Next tab", "Close this tab and send it", "Go to example.com", "Maximize this window!", "Focus the address bar, please"] {
            XCTAssertEqual(SpokenPadCommand.parse("Type " + payload), SpokenPadCommand(action: "typeFocused", value: payload))
            XCTAssertEqual(SpokenPadCommand.parse("Search the web for " + payload), SpokenPadCommand(action: "search", value: payload))
        }
    }

    func testFiniteAppFocusAliasesUseWholeAllowlistedTargets() {
        let apps = [("Calculator", "Calculator"), ("VS Code", "Visual Studio Code"),
                    ("Claude", "Claude"), ("Settings", "System Settings"), ("Codex", "ChatGPT"),
                    ("Cursor", "Cursor"), ("Chrome", "Google Chrome"), ("Safari", "Safari"),
                    ("Texts", "Messages"), ("Face Time", "FaceTime"), ("Notes", "Notes"),
                    ("Finder", "Finder"), ("Text Edit", "TextEdit")]
        for (alias, app) in apps {
            for article in ["", "the "] {
                for suffix in ["", " app"] {
                    let target = article + alias + suffix
                    let phrases = ["Open " + target, "Open up " + target, "Launch " + target,
                                   "Switch to " + target, "Bring up " + target, "Go to " + target,
                                   "Focus " + target, "Bring " + target + " to the front"]
                    for phrase in phrases {
                        XCTAssertEqual(SpokenPadCommand.parse(phrase), SpokenPadCommand(action: "open", value: app), phrase)
                        XCTAssertEqual(SpokenPadCommand.parse("Codex: could you please " + phrase.lowercased() + " for me, please?"),
                                       SpokenPadCommand(action: "open", value: app), phrase)
                    }
                }
            }
        }
    }

    func testFiniteWakePunctuationAndCourtesyWrappers() {
        for wake in ["Hey, Codex, ", "Hey, Codex. ", "Hey, Codex: ", "Hey, Codex! ", "Hey, Codex ",
                     "Hey Codex, ", "Hey Codex. ", "Hey Codex: ", "Hey Codex! ", "Hey Codex ",
                     "Codex, ", "Codex. ", "Codex: ", "Codex! ", "Codex "] {
            for courtesy in ["", "Can you please, ", "Could you please, ", "Would you please, ",
                             "Can you please ", "Could you please ", "Would you please ",
                             "Can you ", "Could you ", "Would you ", "Please, ", "Please "] {
                XCTAssertEqual(SpokenPadCommand.parse(wake + courtesy + "open the Calculator app for me, please!"),
                               SpokenPadCommand(action: "open", value: "Calculator"), wake + courtesy)
                XCTAssertEqual(SpokenPadCommand.parse(wake + courtesy + "type: Keep: this, for me!"),
                               SpokenPadCommand(action: "typeFocused", value: "Keep: this, for me!"), wake + courtesy)
            }
        }
    }

    func testNewFocusAliasesNeverBroadenInstructionScope() {
        let commands = ["Open the Calculator app", "Go to Chrome", "Focus Notes", "Bring Notes to the front"]
        for command in commands {
            for prefix in ["Don't ", "Do not ", "If I say ", "When I say ", "He said ", "Explain how to "] {
                for wake in ["", "Codex: ", "Hey Codex! "] {
                    XCTAssertNil(SpokenPadCommand.parse(wake + prefix + command), wake + prefix + command)
                }
            }
            for quoted in ["\"" + command + "\"", "“" + command + "”", "'" + command + "'"] {
                XCTAssertNil(SpokenPadCommand.parse("Codex: please, " + quoted), quoted)
            }
            for suffix in [" and send it", " then type hello", ", but not now", " if I ask"] {
                XCTAssertNil(SpokenPadCommand.parse("Hey Codex! " + command + suffix), command + suffix)
            }
        }
        for phrase in ["Open Calculator app app", "Open the the Calculator app", "Open Calculatorapp",
                       "Focus CalculatorXYZ", "Focus UnknownApp", "Go to UnknownApp",
                       "Bring Notes and Calculator to the front", "Bring Notes then send it to the front",
                       "Bring the front to the front", "Bring Notes to the front app",
                       "Bring /Applications/Notes.app to the front", "Focus /bin/sh",
                       "Go to Notes app and type hello", "Go to the https://example.com app",
                       "Close Notes app", "Close the Notes window", "Close Calculator",
                       "Press Enter", "Press return", "Send it", "Run it"] {
            XCTAssertNil(SpokenPadCommand.parse("Codex: " + phrase), phrase)
        }
    }

    func testColonFocusedTypingPreservesEveryPayloadByte() {
        let prefixes = ["Type:", "Type into the focused field:", "Type in the focused field:",
                        "Type into the current app:", "Type in the current app:"]
        let payloads = ["Hello: world, please?!", "Cafe\u{0301} and Café — exact text.",
                        "Keep  internal   spaces.\nSecond line.  \n",
                        "  keep leading spaces and trailing spaces  ",
                        "\"Go to Notes\"; press Enter and send it", "Don't open Calculator; type: later!"]
        for prefix in prefixes {
            for payload in payloads {
                let command = SpokenPadCommand.parse("Hey, Codex: could you please, " + prefix + " " + payload)
                XCTAssertEqual(command?.action, "typeFocused", prefix)
                XCTAssertEqual(command.map { Array($0.value.utf8) }, Array(payload.utf8), prefix)
            }
            for payload in ["Hello!", "Cafe\u{0301}", "\nKeep this newline.\n"] {
                XCTAssertEqual(SpokenPadCommand.parse(prefix + payload),
                               SpokenPadCommand(action: "typeFocused", value: payload), prefix)
            }
            for suffix in ["", " ", " \n\t"] {
                XCTAssertNil(SpokenPadCommand.parse(prefix + suffix), prefix + suffix)
            }
        }
    }

    func testColonTypingRejectsOuterNegationQuotationAndConditions() {
        for command in ["Type: hello", "Type into the focused field: hello", "Type in the current app: hello"] {
            for prefix in ["Don't ", "Do not ", "If I say ", "He said ", "Explain "] {
                XCTAssertNil(SpokenPadCommand.parse("Codex: " + prefix + command), prefix + command)
            }
            XCTAssertNil(SpokenPadCommand.parse("Codex: \"" + command + "\""), command)
            XCTAssertNil(SpokenPadCommand.parse("Hey Codex! “" + command + "”"), command)
        }
        XCTAssertEqual(SpokenPadCommand.parse("Type: hello and send it"),
                       SpokenPadCommand(action: "typeFocused", value: "hello and send it"))
        XCTAssertEqual(SpokenPadCommand.parse("Type into the focused field: Press Enter"),
                       SpokenPadCommand(action: "typeFocused", value: "Press Enter"))
        XCTAssertNil(SpokenPadCommand.parse("Type: hello\0world"))
        XCTAssertNil(SpokenPadCommand.parse("Type: " + String(repeating: "x", count: 8000)))
    }

    func testNewFocusWordsStayLiteralInsideExistingPayloadsAndURLs() {
        // A bare allowlisted name selects its app, never an inferred website.
        XCTAssertEqual(SpokenPadCommand.parse("Go to notes"), SpokenPadCommand(action: "open", value: "Notes"))
        for payload in ["Go to Notes", "Bring Calculator to the front, please!",
                        "Open the Calculator app and send it", "Codex: focus Chrome!",
                        "Type into the focused field: Keep: this!"] {
            for (prefix, action) in [("Type ", "typeFocused"), ("Type in TextEdit ", "type"),
                                     ("Search the web for ", "search"), ("Search Google for ", "search")] {
                let command = SpokenPadCommand.parse("Codex. Please, " + prefix + payload)
                XCTAssertEqual(command?.action, action, prefix)
                XCTAssertEqual(command.map { Array($0.value.utf8) }, Array(payload.utf8), prefix)
            }
        }
        let url = "https://Example.com/ReadMe?q=Keep!&note=app#Front"
        for prefix in ["Go to ", "Open ", "Navigate to "] {
            let command = SpokenPadCommand.parse("Hey, Codex! Could you please, " + prefix + url)
            XCTAssertEqual(command?.action, "navigate")
            XCTAssertEqual(command.map { Array($0.value.utf8) }, Array(url.utf8))
        }
    }

}
