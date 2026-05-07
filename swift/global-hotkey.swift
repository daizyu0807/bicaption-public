import ApplicationServices
import Foundation

private let relevantModifierFlags: CGEventFlags = [
    .maskCommand,
    .maskControl,
    .maskShift,
    .maskAlternate,
    .maskSecondaryFn,
]

func emitJSON(_ payload: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
          let text = String(data: data, encoding: .utf8) else { return }
    FileHandle.standardOutput.write((text + "\n").data(using: .utf8)!)
}

struct Options {
    var shouldCheckAccess = false
    var shouldRequestAccess = false
    var shouldListen = false
    var keyCode: Int?
    var modifiers: String = ""
}

func parseOptions(arguments: [String]) -> Options {
    var options = Options()
    var index = 1
    while index < arguments.count {
        let arg = arguments[index]
        switch arg {
        case "--check-access":
            options.shouldCheckAccess = true
        case "--request-access":
            options.shouldRequestAccess = true
        case "--listen":
            options.shouldListen = true
        case "--key-code":
            index += 1
            if index < arguments.count {
                options.keyCode = Int(arguments[index])
            }
        case "--modifiers":
            index += 1
            if index < arguments.count {
                options.modifiers = arguments[index]
            }
        default:
            break
        }
        index += 1
    }
    return options
}

func modifierFlags(from rawValue: String) -> CGEventFlags {
    guard !rawValue.isEmpty else { return [] }
    return rawValue
        .split(separator: ",")
        .reduce(into: CGEventFlags()) { flags, token in
            switch token.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
            case "cmd", "command":
                flags.insert(.maskCommand)
            case "ctrl", "control":
                flags.insert(.maskControl)
            case "shift":
                flags.insert(.maskShift)
            case "alt", "option":
                flags.insert(.maskAlternate)
            default:
                break
            }
        }
}

func currentPermissionStatus() -> [String: Any] {
    let bundle = Bundle.main
    return [
        "type": "permission_status",
        "trusted": CGPreflightListenEventAccess(),
        "identifier": bundle.bundleIdentifier ?? "unknown",
        "executablePath": bundle.executablePath ?? CommandLine.arguments.first ?? "",
    ]
}

final class GlobalHotkeyListener {
    private let keyCode: Int64
    private let requiredFlags: CGEventFlags
    private let isModifierOnlyBinding: Bool
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var modifierOnlyPressed = false

    init(keyCode: Int, requiredFlags: CGEventFlags) {
        self.keyCode = Int64(keyCode)
        self.requiredFlags = requiredFlags
        self.isModifierOnlyBinding = requiredFlags.isEmpty && (keyCode == 59 || keyCode == 63)
    }

    func start() {
        let mask = (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)
        let callback: CGEventTapCallBack = { _, type, event, userInfo in
            guard let userInfo else {
                return Unmanaged.passUnretained(event)
            }
            let listener = Unmanaged<GlobalHotkeyListener>.fromOpaque(userInfo).takeUnretainedValue()
            return listener.handle(type: type, event: event)
        }

        let userInfo = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(mask),
            callback: callback,
            userInfo: userInfo
        ) else {
            emitJSON([
                "type": "error",
                "message": "Failed to create global event tap",
            ])
            exit(2)
        }

        eventTap = tap
        runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        emitJSON([
            "type": "listener_ready",
            "keyCode": keyCode,
        ])
        RunLoop.current.run()
    }

    private func handle(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let eventTap {
                CGEvent.tapEnable(tap: eventTap, enable: true)
            }
            return Unmanaged.passUnretained(event)
        }

        if isModifierOnlyBinding {
            return handleModifierOnly(type: type, event: event)
        }

        guard type == .keyDown || type == .keyUp else {
            return Unmanaged.passUnretained(event)
        }
        let eventKeyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let eventFlags = event.flags.intersection(relevantModifierFlags)
        guard eventKeyCode == keyCode, eventFlags == requiredFlags else {
            return Unmanaged.passUnretained(event)
        }

        emitJSON([
            "type": type == .keyDown ? "hotkey_down" : "hotkey_up",
            "keyCode": eventKeyCode,
            "modifiers": [
                "command": eventFlags.contains(.maskCommand),
                "control": eventFlags.contains(.maskControl),
                "shift": eventFlags.contains(.maskShift),
                "option": eventFlags.contains(.maskAlternate),
            ],
        ])
        return Unmanaged.passUnretained(event)
    }

    private func handleModifierOnly(type: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        let eventKeyCode = event.getIntegerValueField(.keyboardEventKeycode)
        let eventFlags = event.flags.intersection(relevantModifierFlags)

        if type == .keyDown {
            if modifierOnlyPressed && eventKeyCode != keyCode {
                modifierOnlyPressed = false
                emitJSON([
                    "type": "hotkey_up",
                    "keyCode": eventKeyCode,
                    "cancelled": true,
                    "modifiers": [
                        "command": eventFlags.contains(.maskCommand),
                        "control": eventFlags.contains(.maskControl),
                        "shift": eventFlags.contains(.maskShift),
                        "option": eventFlags.contains(.maskAlternate),
                        "fn": eventFlags.contains(.maskSecondaryFn),
                    ],
                ])
            }
            return Unmanaged.passUnretained(event)
        }

        guard type == .flagsChanged else {
            return Unmanaged.passUnretained(event)
        }

        let isPressed: Bool
        switch keyCode {
        case 59:
            isPressed = eventFlags == .maskControl
        case 63:
            isPressed = eventFlags == .maskSecondaryFn
        default:
            return Unmanaged.passUnretained(event)
        }

        guard modifierOnlyPressed != isPressed else {
            return Unmanaged.passUnretained(event)
        }

        modifierOnlyPressed = isPressed
        emitJSON([
            "type": isPressed ? "hotkey_down" : "hotkey_up",
            "keyCode": eventKeyCode,
            "modifiers": [
                "command": eventFlags.contains(.maskCommand),
                "control": eventFlags.contains(.maskControl),
                "shift": eventFlags.contains(.maskShift),
                "option": eventFlags.contains(.maskAlternate),
                "fn": eventFlags.contains(.maskSecondaryFn),
            ],
        ])
        return Unmanaged.passUnretained(event)
    }
}

let options = parseOptions(arguments: CommandLine.arguments)

if options.shouldRequestAccess {
    emitJSON([
        "type": "permission_status",
        "trusted": CGRequestListenEventAccess(),
    ])
    exit(0)
}

if options.shouldCheckAccess {
    emitJSON(currentPermissionStatus())
    exit(0)
}

if options.shouldListen {
    guard let keyCode = options.keyCode else {
        emitJSON([
            "type": "error",
            "message": "Missing --key-code for --listen",
        ])
        exit(1)
    }
    guard CGPreflightListenEventAccess() else {
        emitJSON(currentPermissionStatus())
        exit(2)
    }
    let listener = GlobalHotkeyListener(keyCode: keyCode, requiredFlags: modifierFlags(from: options.modifiers))
    listener.start()
    exit(0)
}

emitJSON([
    "type": "usage",
    "message": "Use --check-access, --request-access, or --listen --key-code <code> [--modifiers cmd,shift]",
])
