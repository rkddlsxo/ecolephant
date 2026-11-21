// AirPods head-motion helper (macOS 14+, AirPods Pro / Max / 3rd gen or other head-tracking headphones).
//
// Reads head motion with CMHeadphoneMotionManager and serves it to the ecolephant web app on a
// loopback-only WebSocket, following docs/api/airpods-websocket.md (protocol 1.0):
//   web → client.hello (pairing code) → helper.ready → clock.ping/pong → motion.sample, sensor.status
// Optional: --record writes the samples to a CSV for offline experiments, --print shows live pitch
// for the axis check (README.md). No camera access, nothing leaves this computer.
//
// Not built or run in CI: needs a Mac with supported AirPods. First run = first verification.

import CoreMotion
import Foundation
import Network

// MARK: - Options

struct Options {
    var port: UInt16 = 8765
    var origins: [String] = ["http://127.0.0.1:5173", "http://localhost:5173"]
    var rateHz: Double = 20
    var record: String?
    var printPitch = false
    var serve = true
}

let usage = """
    airpods-helper — AirPods 머리 움직임을 이 컴퓨터의 브라우저로 보내는 도우미

    사용: swift run airpods-helper [옵션]
      --port N              WebSocket 포트 (기본 8765, 127.0.0.1에서만 열림)
      --allow-origin URL    허용할 웹 주소, 여러 번 쓸 수 있음
                            (기본 http://127.0.0.1:5173, http://localhost:5173)
      --rate HZ             보낼 주기 (기본 20, 1~100)
      --record FILE.csv     샘플을 CSV로 저장 (실험용)
      --print               1초마다 pitch/roll을 터미널에 표시 (축 확인용)
      --no-serve            WebSocket을 열지 않음 (--record, --print만 쓸 때)
      --help                이 도움말
    """

func parseOptions() -> Options {
    var options = Options()
    var customOrigins: [String] = []
    var args = Array(CommandLine.arguments.dropFirst())
    func value(_ flag: String) -> String {
        guard !args.isEmpty else {
            fputs("\(flag) 다음에 값이 필요합니다\n", stderr)
            exit(2)
        }
        return args.removeFirst()
    }
    while !args.isEmpty {
        let arg = args.removeFirst()
        switch arg {
        case "--port":
            guard let port = UInt16(value(arg)), port >= 1024 else {
                fputs("--port는 1024~65535 사이 숫자입니다\n", stderr)
                exit(2)
            }
            options.port = port
        case "--allow-origin":
            customOrigins.append(value(arg))
        case "--rate":
            guard let rate = Double(value(arg)), rate >= 1, rate <= 100 else {
                fputs("--rate는 1~100 사이 숫자입니다\n", stderr)
                exit(2)
            }
            options.rateHz = rate
        case "--record":
            options.record = value(arg)
        case "--print":
            options.printPitch = true
        case "--no-serve":
            options.serve = false
        case "--help", "-h":
            print(usage)
            exit(0)
        default:
            fputs("알 수 없는 옵션: \(arg)\n\n\(usage)\n", stderr)
            exit(2)
        }
    }
    if !customOrigins.isEmpty { options.origins = customOrigins }
    return options
}

// MARK: - Shared state (everything below runs on this serial queue)

let queue = DispatchQueue(label: "ecolephant.airpods-helper")

/// Same base as CMDeviceMotion.timestamp (seconds since boot), in ms.
func monotonicMs() -> Double { ProcessInfo.processInfo.systemUptime * 1000 }

func makePairingToken() -> String {
    // SystemRandomNumberGenerator is cryptographically secure on Apple platforms.
    var generator = SystemRandomNumberGenerator()
    return (0..<24).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &generator)) }.joined()
}

/// Constant-time comparison so a wrong code does not leak how many characters matched.
func sameToken(_ a: String, _ b: String) -> Bool {
    let x = Array(a.utf8), y = Array(b.utf8)
    guard x.count == y.count else { return false }
    var diff: UInt8 = 0
    for i in 0..<x.count { diff |= x[i] ^ y[i] }
    return diff == 0
}

// MARK: - CSV recorder

final class Recorder {
    private let handle: FileHandle
    let path: String
    private(set) var rows = 0

    init(path: String) throws {
        self.path = path
        FileManager.default.createFile(atPath: path, contents: nil)
        guard let handle = FileHandle(forWritingAtPath: path) else {
            throw NSError(domain: "airpods-helper", code: 1, userInfo: [NSLocalizedDescriptionKey: "파일을 열 수 없음: \(path)"])
        }
        self.handle = handle
        write("helper_monotonic_ms,seq,pitch_rad,roll_rad,yaw_rad,rot_x,rot_y,rot_z,status\n")
    }

    func append(ms: Double, seq: Int, pitch: Double, roll: Double, yaw: Double, rate: CMRotationRate, status: String) {
        write(String(format: "%.3f,%d,%.6f,%.6f,%.6f,%.5f,%.5f,%.5f,%@\n", ms, seq, pitch, roll, yaw, rate.x, rate.y, rate.z, status))
        rows += 1
    }

    func close() {
        try? handle.synchronize()
        try? handle.close()
    }

    private func write(_ text: String) {
        if let data = text.data(using: .utf8) { handle.write(data) }
    }
}

// MARK: - Motion source

final class MotionSource: NSObject, CMHeadphoneMotionManagerDelegate {
    private let manager = CMHeadphoneMotionManager()
    private let operations: OperationQueue = {
        let ops = OperationQueue()
        ops.maxConcurrentOperationCount = 1
        ops.underlyingQueue = queue
        return ops
    }()
    var onSample: ((CMDeviceMotion) -> Void)?
    var onStatus: ((String) -> Void)?
    private(set) var status = "disconnected"
    var available: Bool { manager.isDeviceMotionAvailable }

    func start() {
        manager.delegate = self
        guard manager.isDeviceMotionAvailable else {
            update("motion_unavailable")
            print("⚠ 이 기기에서 헤드폰 모션을 쓸 수 없습니다 (macOS 14 이상, 머리 추적 지원 AirPods 필요).")
            return
        }
        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .denied, .restricted:
            update("permission_denied")
            print("⚠ 모션 권한이 꺼져 있습니다. 시스템 설정 → 개인정보 보호 및 보안 → 모션 및 피트니스에서 허용해 주세요.")
            return
        default:
            break
        }
        manager.startDeviceMotionUpdates(to: operations) { [weak self] motion, error in
            guard let self else { return }
            if let error {
                print("⚠ 모션 오류: \(error.localizedDescription)")
                return
            }
            guard let motion else { return }
            if self.status != "connected" { self.update("connected") }
            self.onSample?(motion)
        }
        print("AirPods를 귀에 끼우면 값이 들어옵니다…")
    }

    func stop() { manager.stopDeviceMotionUpdates() }

    func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        queue.async { self.update("connected") }
    }

    func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        queue.async { self.update("disconnected") }
    }

    private func update(_ next: String) {
        guard next != status else { return }
        status = next
        print("AirPods 상태: \(next)")
        onStatus?(next)
    }
}

// MARK: - WebSocket server (loopback only)

final class HelperServer {
    private let options: Options
    private let token: String
    private var listener: NWListener?
    private var client: NWConnection?
    private var authenticated = false
    private var streamId = UUID().uuidString.lowercased()
    private var failures = 0
    private var lockedUntil = 0.0
    var motionAvailable: () -> Bool = { false }
    var currentStatus: () -> String = { "disconnected" }

    init(options: Options, token: String) {
        self.options = options
        self.token = token
    }

    func start() throws {
        let websocket = NWProtocolWebSocket.Options()
        websocket.autoReplyPing = true
        websocket.maximumMessageSize = 4096
        let allowed = options.origins
        // The handshake is refused unless the browser's Origin header is on the allow list.
        websocket.setClientRequestHandler(queue) { _, headers in
            let origin = headers.first { $0.name.lowercased() == "origin" }?.value
            if let origin, allowed.contains(origin) {
                return NWProtocolWebSocket.Response(status: .accept, subprotocol: nil)
            }
            print("거부: 허용되지 않은 Origin \(origin ?? "(없음)")")
            return NWProtocolWebSocket.Response(status: .reject, subprotocol: nil)
        }
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(websocket, at: 0)
        parameters.requiredInterfaceType = .loopback // never reachable from the network
        parameters.allowLocalEndpointReuse = true
        guard let port = NWEndpoint.Port(rawValue: options.port) else { throw NSError(domain: "airpods-helper", code: 2) }
        let listener = try NWListener(using: parameters, on: port)
        listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
        listener.stateUpdateHandler = { [port = options.port] state in
            switch state {
            case .ready:
                print("대기 중: ws://127.0.0.1:\(port)")
            case let .failed(error):
                print("⚠ 서버를 열 수 없습니다: \(error). 다른 --port를 써 보세요.")
                exit(1)
            default:
                break
            }
        }
        listener.start(queue: queue)
        self.listener = listener
    }

    func stop() {
        client?.cancel()
        listener?.cancel()
    }

    /// One browser at a time: a new connection replaces the old one (and must pair again).
    private func accept(_ connection: NWConnection) {
        if let old = client { old.cancel() }
        client = connection
        authenticated = false
        streamId = UUID().uuidString.lowercased()
        connection.stateUpdateHandler = { [weak self, weak connection] state in
            guard let self, let connection else { return }
            switch state {
            case .failed, .cancelled:
                if self.client === connection {
                    self.client = nil
                    self.authenticated = false
                    print("브라우저 연결 끊김")
                }
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive(connection)
    }

    private func receive(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self else { return }
            if let data, let context,
               let meta = context.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata,
               meta.opcode == .text
            {
                self.handle(connection, data: data)
            }
            if error == nil, self.client === connection { self.receive(connection) }
        }
    }

    private func handle(_ connection: NWConnection, data: Data) {
        let receivedMs = monotonicMs()
        guard client === connection,
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else { return }

        guard authenticated else {
            // Before pairing only client.hello is accepted; nothing else is sent.
            guard type == "client.hello" else { return close(connection, error: "authentication_failed") }
            if receivedMs < lockedUntil { return close(connection, error: "rate_limited") }
            guard object["protocol_version"] as? String == "1.0" else { return close(connection, error: "protocol_unsupported") }
            guard let code = object["pairing_token"] as? String, sameToken(code, token) else {
                failures += 1
                if failures >= 5 {
                    lockedUntil = receivedMs + 30_000
                    failures = 0
                }
                print("페어링 실패 (코드 불일치)")
                return close(connection, error: "authentication_failed")
            }
            authenticated = true
            failures = 0
            print("브라우저 페어링 완료")
            send(connection, [
                "type": "helper.ready",
                "protocol_version": "1.0",
                "stream_id": streamId,
                "sample_rate_hz": options.rateHz,
                "head_motion_available": motionAvailable(),
                "clock_unit": "ms",
            ])
            sendStatus(currentStatus())
            return
        }

        if type == "clock.ping",
           let pingId = object["ping_id"] as? String,
           let sent = object["web_send_monotonic_ms"] as? Double
        {
            send(connection, [
                "type": "clock.pong",
                "ping_id": pingId,
                "web_send_monotonic_ms": sent,
                "helper_received_ms": receivedMs,
                "helper_sent_ms": monotonicMs(),
            ])
        }
    }

    func sendMotion(seq: Int, ms: Double, pitch: Double, roll: Double, rate: CMRotationRate) {
        guard authenticated, let client else { return }
        send(client, [
            "type": "motion.sample",
            "stream_id": streamId,
            "seq": seq,
            "helper_monotonic_ms": ms,
            "pitch_rad": pitch,
            "roll_rad": roll,
            "rotation_rate_rad_s": ["x": rate.x, "y": rate.y, "z": rate.z],
        ])
    }

    func sendStatus(_ status: String) {
        guard authenticated, let client else { return }
        // Wear detection is not exposed by the API: worn_state stays "unknown" (contract).
        send(client, ["type": "sensor.status", "stream_id": streamId, "status": status, "worn_state": "unknown"])
    }

    private func close(_ connection: NWConnection, error code: String) {
        send(connection, ["type": "helper.error", "code": code])
        queue.asyncAfter(deadline: .now() + 0.2) { connection.cancel() }
    }

    private func send(_ connection: NWConnection, _ message: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        let meta = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "message", metadata: [meta])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }
}

// MARK: - Main

let options = parseOptions()
let token = makePairingToken()
let motion = MotionSource()
let server: HelperServer? = options.serve ? HelperServer(options: options, token: token) : nil
var recorder: Recorder?
var seq = 0
var lastSentTimestamp = -Double.infinity
var lastPrinted = 0.0
var skippedOutOfRange = 0
let minInterval = 1.0 / options.rateHz

if let path = options.record {
    do {
        recorder = try Recorder(path: path)
        print("기록 파일: \(path)")
    } catch {
        fputs("⚠ \(error.localizedDescription)\n", stderr)
        exit(1)
    }
}

motion.onSample = { sample in
    // Throttle to the announced rate; small tolerance so 20 Hz does not drop to 10 Hz.
    guard sample.timestamp - lastSentTimestamp >= minInterval * 0.9 else { return }
    let rate = sample.rotationRate
    // Contract range check (±100 rad/s): out-of-range values are dropped, never clamped.
    guard abs(rate.x) <= 100, abs(rate.y) <= 100, abs(rate.z) <= 100 else {
        skippedOutOfRange += 1
        return
    }
    lastSentTimestamp = sample.timestamp
    seq += 1
    let ms = sample.timestamp * 1000
    let attitude = sample.attitude
    recorder?.append(ms: ms, seq: seq, pitch: attitude.pitch, roll: attitude.roll, yaw: attitude.yaw, rate: rate, status: motion.status)
    server?.sendMotion(seq: seq, ms: ms, pitch: attitude.pitch, roll: attitude.roll, rate: rate)
    if options.printPitch, sample.timestamp - lastPrinted >= 1 {
        lastPrinted = sample.timestamp
        print(String(format: "pitch %+6.1f°   roll %+6.1f°   yaw %+6.1f°", attitude.pitch * 180 / .pi, attitude.roll * 180 / .pi, attitude.yaw * 180 / .pi))
    }
}
motion.onStatus = { status in server?.sendStatus(status) }

print("""
    ── ecolephant AirPods 도우미 ──
    허용 주소: \(options.origins.joined(separator: ", "))
    """)
if let server {
    server.motionAvailable = { motion.available }
    server.currentStatus = { motion.status }
    print("페어링 코드 (브라우저에 붙여 넣기, 이번 실행에서만 유효):\n\n    \(token)\n")
    do {
        try server.start()
    } catch {
        fputs("⚠ 서버를 열 수 없습니다: \(error)\n", stderr)
        exit(1)
    }
}
queue.async { motion.start() }

// Ctrl+C: stop cleanly so the CSV is complete.
signal(SIGINT, SIG_IGN)
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: queue)
interrupt.setEventHandler {
    motion.stop()
    server?.stop()
    if let recorder {
        recorder.close()
        print("\n기록 \(recorder.rows)줄 저장: \(recorder.path)")
    }
    if skippedOutOfRange > 0 { print("범위를 벗어나 버린 샘플: \(skippedOutOfRange)개") }
    exit(0)
}
interrupt.resume()
dispatchMain()
