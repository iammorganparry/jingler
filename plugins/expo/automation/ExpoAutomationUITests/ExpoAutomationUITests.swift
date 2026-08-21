import XCTest

private struct Selector: Decodable {
    let identifier: String?
    let label: String?
    let text: String?
}

private struct Action: Decodable {
    let kind: String
    let selector: Selector?
    let text: String?
    let replace: Bool?
    let direction: String?
    let button: String?
    let timeout: Double?
}

private struct Result: Encodable {
    let ok: Bool
    let kind: String
    let value: String?
    let error: String?
}

final class ExpoAutomationUITests: XCTestCase {
    private func emit(_ result: Result) {
        let data = try! JSONEncoder().encode(result)
        print("JINGLER_EXPO_RESULT:\(data.base64EncodedString())")
    }

    private func action() throws -> Action {
        guard
            let encoded = ProcessInfo.processInfo.environment["JINGLER_EXPO_ACTION"],
            let data = Data(base64Encoded: encoded)
        else { throw NSError(domain: "ExpoAutomation", code: 1, userInfo: [NSLocalizedDescriptionKey: "Missing automation action."]) }
        return try JSONDecoder().decode(Action.self, from: data)
    }

    private func application() throws -> XCUIApplication {
        guard let bundleId = ProcessInfo.processInfo.environment["JINGLER_EXPO_BUNDLE_ID"], !bundleId.isEmpty
        else { throw NSError(domain: "ExpoAutomation", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing app bundle identifier."]) }
        let app = XCUIApplication(bundleIdentifier: bundleId)
        app.activate()
        return app
    }

    private func elements(_ selector: Selector, in app: XCUIApplication) throws -> [XCUIElement] {
        let query = app.descendants(matching: .any)
        if let identifier = selector.identifier, !identifier.isEmpty {
            return query.matching(identifier: identifier).allElementsBoundByIndex
        }
        if let label = selector.label, !label.isEmpty {
            return query.matching(NSPredicate(format: "label == %@", label)).allElementsBoundByIndex
        }
        if let text = selector.text, !text.isEmpty {
            return query.matching(NSPredicate(format: "label == %@ OR value == %@", text, text)).allElementsBoundByIndex
        }
        throw NSError(domain: "ExpoAutomation", code: 3, userInfo: [NSLocalizedDescriptionKey: "A non-empty identifier, label, or text selector is required."])
    }

    private func one(_ selector: Selector?, in app: XCUIApplication, timeout: Double) throws -> XCUIElement {
        guard let selector else {
            throw NSError(domain: "ExpoAutomation", code: 4, userInfo: [NSLocalizedDescriptionKey: "This action requires a selector."])
        }
        var matches = try elements(selector, in: app)
        if matches.isEmpty {
            let candidate = app.descendants(matching: .any).matching(NSPredicate(format: "identifier == %@ OR label == %@ OR value == %@", selector.identifier ?? "", selector.label ?? selector.text ?? "", selector.text ?? "")).firstMatch
            _ = candidate.waitForExistence(timeout: timeout)
            matches = try elements(selector, in: app)
        }
        guard matches.count == 1 else {
            throw NSError(domain: "ExpoAutomation", code: 5, userInfo: [NSLocalizedDescriptionKey: matches.isEmpty ? "No matching accessibility element was found." : "The selector matched more than one accessibility element."])
        }
        return matches[0]
    }

    func testAction() throws {
        do {
            let action = try action()
            let app = try application()
            let timeout = min(max(action.timeout ?? 5, 0.1), 30)
            var value: String? = nil

            switch action.kind {
            case "describe":
                value = String(app.debugDescription.prefix(20_000))
            case "wait":
                _ = try one(action.selector, in: app, timeout: timeout)
                value = "found"
            case "tap":
                try one(action.selector, in: app, timeout: timeout).tap()
                value = "tapped"
            case "type":
                let element = try one(action.selector, in: app, timeout: timeout)
                guard let text = action.text else { throw NSError(domain: "ExpoAutomation", code: 6, userInfo: [NSLocalizedDescriptionKey: "Type requires text."]) }
                element.tap()
                if action.replace == true, let current = element.value as? String, !current.isEmpty {
                    element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: current.count))
                }
                element.typeText(text)
                value = "typed"
            case "swipe":
                switch action.direction {
                case "up": app.swipeUp()
                case "down": app.swipeDown()
                case "left": app.swipeLeft()
                case "right": app.swipeRight()
                default: throw NSError(domain: "ExpoAutomation", code: 7, userInfo: [NSLocalizedDescriptionKey: "Swipe direction must be up, down, left, or right."])
                }
                value = "swiped"
            case "button":
                guard action.button == "home" else { throw NSError(domain: "ExpoAutomation", code: 8, userInfo: [NSLocalizedDescriptionKey: "Only the home button is supported."]) }
                XCUIDevice.shared.press(.home)
                value = "pressed"
            default:
                throw NSError(domain: "ExpoAutomation", code: 9, userInfo: [NSLocalizedDescriptionKey: "Unknown automation action."])
            }
            emit(Result(ok: true, kind: action.kind, value: value, error: nil))
        } catch {
            emit(Result(ok: false, kind: "error", value: nil, error: error.localizedDescription))
            XCTFail(error.localizedDescription)
        }
    }
}
