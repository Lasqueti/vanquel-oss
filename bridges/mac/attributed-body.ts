// bridges/mac/attributed-body.ts
// -----------------------------------------------------------------------------
// The words of a message, read from chat.db's attributedBody column.
//
// WHY. Messages.app writes a row's words to message.text AND to attributedBody,
// then clears message.text a few seconds later. On the Mac mini 99% of inbound
// rows and every outbound row have text NULL at rest (measured 2026-10-07).
// The watcher only kept up because it reads each row within ~500 ms; a late
// read (an outage backlog, a crash loop, a reboot) saw an empty message and
// dropped it without a word.
//
// FORMAT. attributedBody is an NSAttributedString archived by NSArchiver in
// NeXTSTEP's typedstream format:
//   header         4, "streamtyped", the system version
//   "@" object     the NSAttributedString (class chain down to NSObject)
//     "@" object   its string, an NSString or NSMutableString
//       "+"        the UTF-8 bytes, length first        <- the words
//     ...          attribute runs, not needed here
// An integer is one signed byte, or 0x81 then int16 LE, or 0x82 then int32 LE.
// 0x84 starts a new string, class or object; 0x85 is nil; a value from 0x92
// up (read as a signed integer, plus 110) refers back to an earlier one.
// Strings (type codes, class names) and objects (classes included) are
// numbered in separate tables, in the order they first appear.
//
// This reads exactly that path. Anything else returns null: unreadable, never
// a guess.
// -----------------------------------------------------------------------------

const TAG_INT16 = 0x81;
const TAG_INT32 = 0x82;
const TAG_NEW = 0x84;
const TAG_NIL = 0x85;
const FIRST_TAG = 0x80;
const LAST_TAG = 0x91;
const REFERENCE_OFFSET = 110;

const utf8 = new TextDecoder('utf-8', { fatal: true });

type Reader = { bytes: Uint8Array; pos: number; strings: string[]; objects: Array<string | null> };

function nextByte(r: Reader): number {
    if (r.pos >= r.bytes.length) throw new RangeError('truncated');
    return r.bytes[r.pos++];
}

// An integer whose first byte has already been read.
function integer(r: Reader, head: number): number {
    if (head === TAG_INT16 || head === TAG_INT32) {
        const size = head === TAG_INT16 ? 2 : 4;
        if (r.pos + size > r.bytes.length) throw new RangeError('truncated');
        const view = new DataView(r.bytes.buffer, r.bytes.byteOffset + r.pos, size);
        r.pos += size;
        return size === 2 ? view.getInt16(0, true) : view.getInt32(0, true);
    }
    if (head >= FIRST_TAG && head <= LAST_TAG) throw new TypeError(`tag ${head} where an integer belongs`);
    return head > 0x7f ? head - 0x100 : head;
}

function take(r: Reader, length: number): Uint8Array {
    if (length < 0 || r.pos + length > r.bytes.length) throw new RangeError('truncated');
    r.pos += length;
    return r.bytes.subarray(r.pos - length, r.pos);
}

function sharedString(r: Reader): string {
    const head = nextByte(r);
    if (head === TAG_NEW) {
        const value = utf8.decode(take(r, integer(r, nextByte(r))));
        r.strings.push(value);
        return value;
    }
    const value = r.strings[integer(r, head) + REFERENCE_OFFSET];
    if (value === undefined) throw new RangeError('unknown string reference');
    return value;
}

// A class and its superclasses down to nil. Returns the class's own name.
function className(r: Reader): string | null {
    const head = nextByte(r);
    if (head === TAG_NIL) return null;
    if (head === TAG_NEW) {
        const name = sharedString(r);
        integer(r, nextByte(r)); // class version
        r.objects.push(name);
        className(r);
        return name;
    }
    const name = r.objects[integer(r, head) + REFERENCE_OFFSET];
    if (typeof name !== 'string') throw new RangeError('unknown class reference');
    return name;
}

// The start of a new object of a class whose name ends in `suffix`.
function newObject(r: Reader, suffix: string): boolean {
    if (sharedString(r) !== '@' || nextByte(r) !== TAG_NEW) return false;
    r.objects.push(null);
    return className(r)?.endsWith(suffix) === true;
}

export function attributedBodyText(blob: Uint8Array | null | undefined): string | null {
    if (!blob || blob.length === 0) return null;
    const r: Reader = { bytes: blob, pos: 0, strings: [], objects: [] };
    try {
        if (integer(r, nextByte(r)) !== 4) return null;
        if (utf8.decode(take(r, integer(r, nextByte(r)))) !== 'streamtyped') return null;
        integer(r, nextByte(r)); // system version
        if (!newObject(r, 'AttributedString') || !newObject(r, 'String')) return null;
        if (sharedString(r) !== '+') return null;
        return utf8.decode(take(r, integer(r, nextByte(r))));
    } catch {
        return null;
    }
}
