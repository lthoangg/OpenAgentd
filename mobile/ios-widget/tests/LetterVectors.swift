// Checks LetterOpener against the letter vectors of
// appv3/contract/tunnel_vectors.json. Run by run-letter-vectors.sh on macOS.

import Foundation

@main
struct LetterVectors {
    static func main() throws {
        let path = CommandLine.arguments[1]
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: Any]
        let devices = root["devices"] as! [String: [String: String]]
        let byID = Dictionary(uniqueKeysWithValues: devices.values.map { ($0["id"]!, $0) })
        var checked = 0
        for v in root["letter"] as! [[String: Any]] {
            let sealed = LetterOpener.fromB64(v["sealed"] as! String)!
            let to = byID[v["to"] as! String]!, from = byID[v["from"] as! String]!
            // The sender's public box key: derive it from the vector's seed.
            let senderSeed = LetterOpener.fromB64(from["box"]!)!
            let senderPub = try Curve25519KeyPub(senderSeed)
            var senders: [String: Data] = [:]
            for d in devices.values { senders[d["id"]!] = try Curve25519KeyPub(LetterOpener.fromB64(d["box"]!)!) }
            senders[from["id"]!] = senderPub
            guard let opened = LetterOpener.open(
                sealed: sealed, recipientBoxSeed: LetterOpener.fromB64(to["box"]!)!, recipientID: to["id"]!,
                accountID: v["account_id"] as! String, senders: senders
            ) else { fail("letter of size \(v["size"]!) did not open") }
            guard String(data: opened.json, encoding: .utf8) == v["json"] as? String else { fail("J differs") }
            guard opened.kind == v["kind"] as? String, opened.sender == from["id"] else { fail("sender or kind differs") }
            guard LetterOpener.text(opened.json) != nil else { fail("J does not parse") }
            // One flipped byte must not open.
            var bad = sealed
            bad[bad.count - 1] ^= 1
            guard LetterOpener.open(
                sealed: bad, recipientBoxSeed: LetterOpener.fromB64(to["box"]!)!, recipientID: to["id"]!,
                accountID: v["account_id"] as! String, senders: senders
            ) == nil else { fail("a tampered letter opened") }
            checked += 1
        }
        guard checked >= 4 else { fail("expected the four letter sizes") }
        print("letter vectors: \(checked) passed")
    }

    static func fail(_ msg: String) -> Never {
        FileHandle.standardError.write(Data("letter vectors: \(msg)\n".utf8))
        exit(1)
    }
}

import CryptoKit

func Curve25519KeyPub(_ seed: Data) throws -> Data {
    try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: seed).publicKey.rawRepresentation
}
