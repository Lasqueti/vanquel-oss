// ios/tweak/SmsDbRead.h
// -----------------------------------------------------------------------------
// The two read-only sms.db queries behind /poc/read-games and
// /poc/message-status, shared by the tweak (Tweak.m) and the vanquel-smsdb helper
// (vanquel-smsdb.m) so both answer with exactly the same strings.
//
// WHY A HELPER. On palera1n the kernel patches let SpringBoard open sms.db. On
// Dopamine the platform sandbox is enforced and SpringBoard has no
// com.apple.private.security.storage.Messages entitlement, so the open fails
// ("ERR sms.db not found") and every tweak send that waits on message-status
// (group texts, game balloons) failed on the Dopamine phones. SpringBoard
// cannot be re-signed, so the tweak runs vanquel-smsdb, signed with that
// entitlement, whenever it cannot read the file itself.
// -----------------------------------------------------------------------------
#pragma once
#import <Foundation/Foundation.h>
#include <sqlite3.h>

static NSString *const TWEAK_PHONE_SMS_DB = @"/var/mobile/Library/SMS/sms.db";

// JSON-escape a string value for embedding in our hand-built JSON (guids/bundle
// ids are ASCII, but be defensive about quotes/backslashes/control chars).
static NSString *tweakJsonEscape(NSString *s) {
    if (!s) return @"";
    NSMutableString *o = [NSMutableString stringWithCapacity:s.length + 8];
    for (NSUInteger i = 0; i < s.length; i++) {
        unichar c = [s characterAtIndex:i];
        switch (c) {
            case '"':  [o appendString:@"\\\""]; break;
            case '\\': [o appendString:@"\\\\"]; break;
            case '\n': [o appendString:@"\\n"];  break;
            case '\r': [o appendString:@"\\r"];  break;
            case '\t': [o appendString:@"\\t"];  break;
            default:
                if (c < 0x20) [o appendFormat:@"\\u%04x", c];
                else [o appendFormat:@"%C", c];
        }
    }
    return o;
}

// Inbound (is_from_me=0) GamePigeon app-card balloons newer than a cursor rowid,
// as a JSON array, ROWID ASC, capped at `limit`. Read-only, WAL-aware (mode=ro
// without immutable) with a busy timeout so a live Messages write cannot wedge us.
static NSString *tweakSmsDbReadGames(long long afterRowid, int limit) {
    sqlite3 *db = NULL;
    NSString *uri = [NSString stringWithFormat:@"file:%@?mode=ro", TWEAK_PHONE_SMS_DB];
    int rc = sqlite3_open_v2(uri.UTF8String, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, NULL);
    if (rc != SQLITE_OK) {
        NSString *e = [NSString stringWithFormat:@"ERR sqlite open rc=%d: %s", rc, db ? sqlite3_errmsg(db) : "(null)"];
        if (db) sqlite3_close(db);
        return e;
    }
    sqlite3_busy_timeout(db, 3000);

    const char *sql =
        "SELECT m.ROWID, m.guid, c.guid, m.balloon_bundle_id, m.payload_data "
        "FROM message m "
        "JOIN chat_message_join cmj ON cmj.message_id = m.ROWID "
        "JOIN chat c ON c.ROWID = cmj.chat_id "
        "WHERE m.is_from_me = 0 "
        "AND m.balloon_bundle_id LIKE '%gamepigeon%' "
        "AND m.payload_data IS NOT NULL "
        "AND m.ROWID > ? "
        "ORDER BY m.ROWID ASC LIMIT ?;";
    sqlite3_stmt *st = NULL;
    rc = sqlite3_prepare_v2(db, sql, -1, &st, NULL);
    if (rc != SQLITE_OK) {
        NSString *e = [NSString stringWithFormat:@"ERR sqlite prepare rc=%d: %s", rc, sqlite3_errmsg(db)];
        sqlite3_close(db);
        return e;
    }
    sqlite3_bind_int64(st, 1, afterRowid);
    sqlite3_bind_int(st, 2, limit);

    NSMutableString *json = [NSMutableString stringWithString:@"["];
    int n = 0;
    while (sqlite3_step(st) == SQLITE_ROW) {
        long long rowid = sqlite3_column_int64(st, 0);
        const unsigned char *guid = sqlite3_column_text(st, 1);
        const unsigned char *chatGuid = sqlite3_column_text(st, 2);
        const unsigned char *bid = sqlite3_column_text(st, 3);
        const void *blob = sqlite3_column_blob(st, 4);
        int blobLen = sqlite3_column_bytes(st, 4);
        if (!blob || blobLen <= 0) continue;
        NSData *payload = [NSData dataWithBytes:blob length:blobLen];
        NSString *b64 = [payload base64EncodedStringWithOptions:0];
        NSString *guidS = guid ? [NSString stringWithUTF8String:(const char *)guid] : @"";
        NSString *chatS = chatGuid ? [NSString stringWithUTF8String:(const char *)chatGuid] : @"";
        NSString *bidS = bid ? [NSString stringWithUTF8String:(const char *)bid] : @"";
        if (n > 0) [json appendString:@","];
        [json appendFormat:@"{\"rowid\":%lld,\"guid\":\"%@\",\"chatGuid\":\"%@\",\"bundleId\":\"%@\",\"payloadB64\":\"%@\"}",
            rowid, tweakJsonEscape(guidS), tweakJsonEscape(chatS), tweakJsonEscape(bidS), b64];
        n++;
    }
    [json appendString:@"]"];
    sqlite3_finalize(st);
    sqlite3_close(db);
    return json;
}

// `sendMessage:` only confirms a local IMCore insertion. The transport can still
// leave the row undelivered forever or assign an error later, so the Mac bridge
// reads the outcome here before it commits dedupe state or a follow-up.
// attachments=<n> is how many files this ONE message carries, from the phone's
// own join table: what proves all N files of a stacked bundle landed.
static NSString *tweakSmsDbMessageStatus(NSString *guid) {
    if (!guid.length) return @"ERR missing guid";
    sqlite3 *db = NULL;
    NSString *uri = [NSString stringWithFormat:@"file:%@?mode=ro", TWEAK_PHONE_SMS_DB];
    int rc = sqlite3_open_v2(uri.UTF8String, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_URI, NULL);
    if (rc != SQLITE_OK || !db) {
        if (db) sqlite3_close(db);
        return [NSString stringWithFormat:@"ERR sqlite open rc=%d", rc];
    }
    sqlite3_busy_timeout(db, 3000);
    sqlite3_stmt *st = NULL;
    rc = sqlite3_prepare_v2(db,
        "SELECT ROWID,is_sent,is_delivered,error FROM message WHERE guid=? LIMIT 1",
        -1, &st, NULL);
    if (rc != SQLITE_OK || !st) {
        if (st) sqlite3_finalize(st);
        sqlite3_close(db);
        return [NSString stringWithFormat:@"ERR sqlite prepare rc=%d", rc];
    }
    sqlite3_bind_text(st, 1, guid.UTF8String, -1, SQLITE_TRANSIENT);
    NSString *out = @"OK found=0";
    long long rowid = 0;
    if (sqlite3_step(st) == SQLITE_ROW) {
        rowid = sqlite3_column_int64(st, 0);
        out = [NSString stringWithFormat:@"OK found=1 rowid=%lld sent=%d delivered=%d error=%d",
               rowid, sqlite3_column_int(st, 1),
               sqlite3_column_int(st, 2), sqlite3_column_int(st, 3)];
    }
    sqlite3_finalize(st);
    if (rowid) {
        sqlite3_stmt *ast = NULL;
        if (sqlite3_prepare_v2(db,
                "SELECT COUNT(*) FROM message_attachment_join WHERE message_id=?",
                -1, &ast, NULL) == SQLITE_OK && ast) {
            sqlite3_bind_int64(ast, 1, rowid);
            if (sqlite3_step(ast) == SQLITE_ROW) {
                out = [out stringByAppendingFormat:@" attachments=%d", sqlite3_column_int(ast, 0)];
            }
        }
        if (ast) sqlite3_finalize(ast);
    }
    sqlite3_close(db);
    return out;
}
