// games/gp-archive.swift
// Build: swiftc -O games/gp-archive.swift -o data/games/gp-archive (macOS, Xcode command line tools).
// The games watcher runs it for every reply; see games/README.md.
// =============================================================================
// gp-archive - build an outbound GamePigeon Word Hunt balloon archive
// =============================================================================
// Takes a TEMPLATE .bin (any real GamePigeon card, for its liveLayoutInfo / ai /
// appid / layoutClass blobs), swaps in a new game-state URL + session + caption
// + ldtext, and re-archives to out.bin. Everything else in the template dict is
// preserved byte-for-byte so the balloon still renders as a live Word Hunt card.
//
// CLI: gp-archive <template.bin> <url-file> <session|"new"|"reuse"> <caption> <ldtext> <out.bin>
//   template.bin  path to a real GP card archive (source of liveLayoutInfo/ai/...)
//   url-file      file containing the new "data:?ver=52&data=..." envelope URL
//   session       a UUID string to set as sessionIdentifier, OR
//                   "new"   -> mint a fresh NSUUID()
//                   "reuse" -> keep the template's existing sessionIdentifier
//   caption       userInfo["caption"] text
//   ldtext        the ldtext (link-description) string, e.g. "Word Hunt"
//   out.bin       output archive path
//
// Prints the final URL + session so the caller can verify the round-trip.
// =============================================================================
import Foundation

// GamePigeon's `ai` preview is a 96x72-ish raw bitmap on newer cards (typically
// ~27 KB). Preserving it raw while replacing the URL can push the archived
// MSMessage payload beyond the transportable balloon size; IMCore inserts that
// row locally but it never delivers. Older proven GamePigeon sends store the
// exact preview gzip-compressed (~1-3 KB). Restore that representation before
// re-archiving.
func gzipData(_ data: Data) -> Data? {
    if data.count >= 2 && data[data.startIndex] == 0x1f && data[data.startIndex + 1] == 0x8b {
        return data
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
    process.arguments = ["-c", "-n"]
    let input = Pipe()
    let output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = Pipe()
    do {
        try process.run()
        input.fileHandleForWriting.write(data)
        try input.fileHandleForWriting.close()
        let compressed = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return process.terminationStatus == 0 && !compressed.isEmpty ? compressed : nil
    } catch {
        return nil
    }
}

let args = CommandLine.arguments
guard args.count == 7 else {
    FileHandle.standardError.write("usage: gp-archive <template.bin> <url-file> <session|new|reuse> <caption> <ldtext> <out.bin>\n".data(using: .utf8)!)
    exit(2)
}
let templatePath = args[1]
let urlFilePath  = args[2]
let sessionArg   = args[3]
let caption      = args[4]
let ldtext       = args[5]
let outPath      = args[6]

// --- load template ---------------------------------------------------------
guard let data = try? Data(contentsOf: URL(fileURLWithPath: templatePath)) else {
    FileHandle.standardError.write("gp-archive: cannot read template \(templatePath)\n".data(using: .utf8)!)
    exit(1)
}
guard let unarch = NSKeyedUnarchiver.unarchiveObject(with: data) as? NSDictionary,
      let root = unarch.mutableCopy() as? NSMutableDictionary else {
    FileHandle.standardError.write("gp-archive: template is not an NSDictionary archive\n".data(using: .utf8)!)
    exit(1)
}

// --- new URL ---------------------------------------------------------------
guard let rawUrl = try? String(contentsOfFile: urlFilePath, encoding: .utf8) else {
    FileHandle.standardError.write("gp-archive: cannot read url-file \(urlFilePath)\n".data(using: .utf8)!)
    exit(1)
}
let urlStr = rawUrl.trimmingCharacters(in: .whitespacesAndNewlines)
guard let url = NSURL(string: urlStr) else {
    FileHandle.standardError.write("gp-archive: url-file did not parse as a URL\n".data(using: .utf8)!)
    exit(1)
}
root["URL"] = url

if let ai = root["ai"] as? NSData, ai.length > 8_192,
   let compressed = gzipData(ai as Data), compressed.count < ai.length {
    if compressed.count <= 8_192 {
        root["ai"] = NSMutableData(data: compressed)
    } else if ldtext == "8 Ball" {
        // Noisy pool snapshots barely compress and can still push the complete
        // balloon past the transport ceiling. The URL is the authoritative live
        // game state; omit only this optional preview blob in that case.
        root.removeObject(forKey: "ai")
    }
}

// --- session identifier ----------------------------------------------------
switch sessionArg {
case "new":
    root["sessionIdentifier"] = NSUUID()
case "reuse":
    break // keep whatever the template already had
default:
    if let sess = NSUUID(uuidString: sessionArg) {
        root["sessionIdentifier"] = sess
    } else {
        FileHandle.standardError.write("gp-archive: session arg is not \"new\"/\"reuse\"/a UUID; using new\n".data(using: .utf8)!)
        root["sessionIdentifier"] = NSUUID()
    }
}

// --- ldtext + caption ------------------------------------------------------
root["ldtext"] = ldtext
if let ui = (root["userInfo"] as? NSDictionary)?.mutableCopy() as? NSMutableDictionary {
    ui["caption"] = caption
    root["userInfo"] = ui
} else {
    root["userInfo"] = NSMutableDictionary(dictionary: ["caption": caption])
}

// GamePigeon can attach a large `ai` (asset-info/poster) blob to an inbound
// invite. It is presentation-only and is not present on normal compact outbound
// moves. Reusing it made Mini Golf replies roughly 30 KB; Messages inserted the
// row with is_sent=1 but never delivered it. Strip only oversized poster blobs so
// small metadata, should GamePigeon add any, remains untouched.
let maxReusableAssetInfoBytes = 8 * 1024
var strippedAssetInfoBytes = 0
if let assetInfo = root["ai"] as? Data, assetInfo.count > maxReusableAssetInfoBytes {
    strippedAssetInfoBytes = assetInfo.count
    root.removeObject(forKey: "ai")
}

// --- re-archive ------------------------------------------------------------
let out = NSKeyedArchiver.archivedData(withRootObject: root)
do {
    try out.write(to: URL(fileURLWithPath: outPath))
} catch {
    FileHandle.standardError.write("gp-archive: cannot write \(outPath): \(error)\n".data(using: .utf8)!)
    exit(1)
}

// --- verify round-trip -----------------------------------------------------
if let check = NSKeyedUnarchiver.unarchiveObject(with: out) as? NSDictionary {
    let outUrl = (check["URL"] as? NSURL)?.absoluteString ?? "<none>"
    let outSess = (check["sessionIdentifier"] as? NSUUID)?.uuidString ?? "\(check["sessionIdentifier"] ?? "<none>")"
    let stripped = strippedAssetInfoBytes > 0 ? " strippedAiBytes=\(strippedAssetInfoBytes)" : ""
    print("OK bytes=\(out.count) session=\(outSess) urlLen=\(outUrl.count) urlHead=\(String(outUrl.prefix(30)))\(stripped)")
} else {
    print("OK bytes=\(out.count) (WARNING: re-unarchive check did not return a dictionary)")
}
