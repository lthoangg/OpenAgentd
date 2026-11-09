// Opens a sealed mailbox letter (appv3/contract/tunnel.md, section 6) with
// CryptoKit. Pure Foundation + CryptoKit, so it is also compiled into the
// macOS vector test (`mobile/ios-widget/tests/run-letter-vectors.sh`).
//
//   ikm    = X25519(e, R.box) || X25519(S.box, R.box)
//   info   = lines("agentd-letter-v1", account_id, S.id, R.id, kind, b64(e.public))
//   okm    = HKDF-SHA256(ikm, salt = empty, info, 44)
//   sealed = e.public || AES-256-GCM(okm[0..32], okm[32..44], plaintext)
//
// A push carries only the sealed letter, so the sender and kind are found
// by trying each computer of the verified roster and each kind: the
// AES-GCM tag fails for every wrong guess, and the static-static term means
// only a device of the account can produce a letter that opens.

import CryptoKit
import Foundation

enum LetterOpener {
    static let sizes = [256, 512, 1024, 2048]
    static let kinds = ["done", "needs_you", "failed"]

    struct Text: Decodable, Equatable {
        let v: Int
        let title: String
        let body: String
        let session: String?
        let at: UInt64
    }

    struct Opened {
        let json: Data
        let sender: String
        let kind: String
    }

    static func b64(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// Strict unpadded base64url.
    static func fromB64(_ text: String) -> Data? {
        guard !text.contains("="), !text.contains("+"), !text.contains("/") else { return nil }
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while s.count % 4 != 0 { s += "=" }
        guard let data = Data(base64Encoded: s), b64(data) == text else { return nil }
        return data
    }

    /// `J` for one sender and kind, or nil when the letter does not open.
    static func openJSON(
        sealed: Data, recipientBoxSeed: Data, senderBox: Data,
        accountID: String, senderID: String, recipientID: String, kind: String
    ) -> Data? {
        guard sizes.contains(sealed.count), recipientBoxSeed.count == 32, senderBox.count == 32 else { return nil }
        do {
            let me = try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: recipientBoxSeed)
            let ePub = sealed.prefix(32)
            let e = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: ePub)
            let s = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: senderBox)
            var ikm = Data()
            ikm.append(try me.sharedSecretFromKeyAgreement(with: e).withUnsafeBytes { Data($0) })
            ikm.append(try me.sharedSecretFromKeyAgreement(with: s).withUnsafeBytes { Data($0) })
            // An all-zero term means a low-order point: refuse, as the Rust side does.
            if ikm.prefix(32).allSatisfy({ $0 == 0 }) || ikm.suffix(32).allSatisfy({ $0 == 0 }) { return nil }
            let info = ["agentd-letter-v1", accountID, senderID, recipientID, kind, b64(Data(ePub))].joined(separator: "\n")
            let okm = HKDF<SHA256>.deriveKey(
                inputKeyMaterial: SymmetricKey(data: ikm), salt: Data(), info: Data(info.utf8), outputByteCount: 44
            ).withUnsafeBytes { Data($0) }
            let body = sealed.dropFirst(32)
            let box = try AES.GCM.SealedBox(
                nonce: AES.GCM.Nonce(data: okm.suffix(12)),
                ciphertext: body.dropLast(16), tag: body.suffix(16)
            )
            let pt = try AES.GCM.open(box, using: SymmetricKey(data: okm.prefix(32)))
            let bytes = [UInt8](pt)
            let len = Int(bytes[0]) << 8 | Int(bytes[1])
            guard len + 2 <= bytes.count, bytes[(2 + len)...].allSatisfy({ $0 == 0 }) else { return nil }
            return Data(bytes[2..<(2 + len)])
        } catch {
            return nil
        }
    }

    /// Tries every sender (id → box key) and kind.
    static func open(
        sealed: Data, recipientBoxSeed: Data, recipientID: String, accountID: String, senders: [String: Data]
    ) -> Opened? {
        for (id, box) in senders where id != recipientID {
            for kind in kinds {
                if let json = openJSON(
                    sealed: sealed, recipientBoxSeed: recipientBoxSeed, senderBox: box,
                    accountID: accountID, senderID: id, recipientID: recipientID, kind: kind
                ) {
                    return Opened(json: json, sender: id, kind: kind)
                }
            }
        }
        return nil
    }

    static func text(_ json: Data) -> Text? {
        guard let t = try? JSONDecoder().decode(Text.self, from: json), t.v == 1 else { return nil }
        return t
    }
}
