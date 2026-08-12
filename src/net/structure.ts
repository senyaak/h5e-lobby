// The game's own serialisation — CStructureSaver — as it appears inside GS blobs.
//
// A GS list (gs-data.ts) is Ubisoft's format and carries only strings and blobs.
// Some of those blobs are written by the GAME rather than by the service layer,
// and they are in the game's own format: the class is `CStructureSaver` (RTTI at
// 0x10c4f14 in H5_Game_H5E.exe), its reader is at 0x950b70 and the one primitive
// that defines the bytes is at 0x94ef30. Read off that function:
//
//   field = tag:u8  length  payload[size]
//   length = size<<1 as ONE byte, or (size<<1)|1 as a LITTLE-endian u32
//
// so bit 0 of the first length byte says whether the length is one byte or four,
// and the size is always stored doubled. Nothing else: no magic, no checksum, no
// type byte. A tag is one byte and repeats freely — the reader scans for the tag
// it wants (0x94f070) rather than walking a fixed struct.
//
// What a field MEANS is the game's business, and the same tag means different
// things at different levels. Two documents we care about:
//
//   the room's settings   [4]=4, [1]={ [2]=room id, [3]=lobby id, … }
//   a member's player_info  { [2]=name, … }  — read at 0xdfea70
//
// Exports:
//   type Field                one tag with its bytes
//   readFields(buf)           the fields of one document, in order
//   writeFields(fields)       the bytes of one document
//   findField(fields, tag)    the first field with a tag, as the game scans

export interface Field {
  tag: number;
  value: Buffer;
}

/** Where a field's payload starts and how long it is, or null if it overruns. */
function fieldAt(buf: Buffer, at: number): { from: number; size: number } | null {
  if (at + 2 > buf.length) return null;
  const first = buf[at + 1]!;
  const long = (first & 1) !== 0;
  if (long && at + 5 > buf.length) return null;
  const size = long ? buf.readUInt32LE(at + 1) >>> 1 : first >>> 1;
  const from = at + (long ? 5 : 2);
  return from + size > buf.length ? null : { from, size };
}

/**
 * The fields of one document. Throws on a truncated field: a document that does
 * not divide cleanly into fields is not this format, and guessing past that
 * point invents data.
 */
export function readFields(buf: Buffer): Field[] {
  const fields: Field[] = [];
  let at = 0;
  while (at < buf.length) {
    const found = fieldAt(buf, at);
    if (!found) throw new Error(`CStructureSaver: field at ${at} runs past the end of ${buf.length} bytes`);
    fields.push({ tag: buf[at]!, value: buf.subarray(found.from, found.from + found.size) });
    at = found.from + found.size;
  }
  return fields;
}

/** True when a payload is itself a whole run of fields, edge to edge. */
export function looksLikeFields(buf: Buffer): boolean {
  if (buf.length < 2) return false;
  let at = 0;
  while (at < buf.length) {
    const found = fieldAt(buf, at);
    if (!found) return false;
    at = found.from + found.size;
  }
  return true;
}

export function writeFields(fields: readonly Field[]): Buffer {
  const out: Buffer[] = [];
  for (const { tag, value } of fields) {
    // The client writes the short form whenever it fits, and a reader that only
    // ever wrote the long one would still be read correctly — but a blob we send
    // is compared against blobs the game itself made, so match its choice.
    const header =
      value.length < 0x80
        ? Buffer.from([tag, value.length << 1])
        : (() => {
            const long = Buffer.alloc(5);
            long[0] = tag;
            long.writeUInt32LE(((value.length << 1) | 1) >>> 0, 1);
            return long;
          })();
    out.push(header, value);
  }
  return Buffer.concat(out);
}

/** The first field with this tag — how the game itself looks one up. */
export function findField(fields: readonly Field[], tag: number): Buffer | null {
  return fields.find((f) => f.tag === tag)?.value ?? null;
}
