#!/usr/bin/env python3
"""
Builds public/bin-lod/data/hyg-near.bin from StarIS stars.json (nearest 8000 HYG stars).

Format "HYG2" (little-endian):
- Header (24 bytes): b"HYG2" + uint32 n + float32 scale_pc + float32 max_dist_pc
                    + uint32 name_count + uint32 name_bytes
- int16 xyz[n*3]   : interleaved x,y,z; value = round(coord_pc / scale_pc)
- uint8 mag_q[n]   : mag = -2.0 + mag_q * 0.1; mag_q = clamp(round((mag+2)/0.1),0,255)
- Name table       : name_count entries of struct "<HB" (uint16 star_index, uint8 utf8_len)
                     followed by concatenated UTF-8 name bytes (truncated to 255 bytes)

Drops Sun (dist < 1e-6 pc) and any non-finite rows. Keeps input order otherwise.
Skips empty names.

HYG database by astronexus (David Nash), https://github.com/astronexus/HYG-Database, CC BY-SA 4.0;
this derived file is CC BY-SA 4.0.

Usage:
  curl -L -o stars.json https://staris-b01f2.firebaseapp.com/data/stars.json
  python3 public/bin-lod/scripts/build-hyg-near.py stars.json
"""

import json
import math
import struct
import sys
import os
import argparse
import tempfile


def verify_names(data, n, name_count, name_bytes, name_table):
    table_offset = 24 + n * 6 + n
    table_end = table_offset + name_count * 3
    blob_start = table_end
    blob_end = blob_start + name_bytes
    if blob_end != len(data):
        print("Verification failed: name blob does not end at end of file", file=sys.stderr)
        sys.exit(1)
    table = data[table_offset:table_end]
    blob = data[blob_start:blob_end]
    pos = 0
    blob_pos = 0
    for i in range(name_count):
        if pos + 3 > len(table):
            print("Verification failed: table overrun", file=sys.stderr)
            sys.exit(1)
        idx = int.from_bytes(table[pos:pos+2], "little")
        length = table[pos + 2]
        pos += 3
        if blob_pos + length > len(blob):
            print("Verification failed: name data overrun", file=sys.stderr)
            sys.exit(1)
        name = blob[blob_pos:blob_pos + length]
        blob_pos += length
        if i >= len(name_table) or name_table[i][0] != idx or name_table[i][1] != name:
            print("Verification failed: name table mismatch at entry", i, file=sys.stderr)
            sys.exit(1)
    if blob_pos != name_bytes:
        print("Verification failed: name bytes sum mismatch", file=sys.stderr)
        sys.exit(1)
    if pos != len(table):
        print("Verification failed: table did not consume all bytes", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Build hyg-near.bin from stars.json")
    parser.add_argument("input", help="Path to stars.json")
    parser.add_argument("--out", default=None, help="Output path (default: ../data/hyg-near.bin relative to script)")
    args = parser.parse_args()

    script_dir = os.path.dirname(os.path.abspath(__file__))
    default_out = os.path.join(script_dir, "..", "data", "hyg-near.bin")
    out_path = args.out or default_out
    out_path = os.path.abspath(out_path)

    if not args.out:
        # When using default, refuse to overwrite anything that isn't exactly hyg-near.bin
        if os.path.basename(out_path) != "hyg-near.bin":
            print("Error: default output basename must be hyg-near.bin", file=sys.stderr)
            sys.exit(1)
    else:
        # If --out given explicitly, allow any name but still create parent dirs
        pass

    os.makedirs(os.path.dirname(out_path), exist_ok=True)

    with open(args.input, "r", encoding="utf-8") as f:
        stars = json.load(f)

    kept = []
    names = []
    max_abs_coord = 0.0
    dropped = 0
    name_count = 0
    name_bytes_total = 0

    for i, star in enumerate(stars):
        x = star.get("x")
        y = star.get("y")
        z = star.get("z")
        mag = star.get("mag")
        proper = star.get("proper")

        if not all(isinstance(v, (int, float)) for v in (x, y, z, mag)):
            dropped += 1
            continue
        if not math.isfinite(x) or not math.isfinite(y) or not math.isfinite(z) or not math.isfinite(mag):
            dropped += 1
            continue

        dist = math.sqrt(x*x + y*y + z*z)
        if dist < 1e-6:  # Sun
            dropped += 1
            continue

        max_abs_coord = max(max_abs_coord, abs(x), abs(y), abs(z))

        name_data = None
        if proper and isinstance(proper, str):
            proper = proper.strip()
            if proper:
                utf8 = proper.encode("utf-8")
                if len(utf8) > 255:
                    # truncate on utf-8 boundary
                    utf8 = utf8[:255]
                    while utf8 and (utf8[-1] & 0xC0) == 0x80:
                        utf8 = utf8[:-1]
                name_data = (i - dropped, utf8)  # index in final kept list will be corrected later
                name_bytes_total += len(utf8)
                name_count += 1

        kept.append((x, y, z, mag, name_data))

    if not kept:
        print("Error: no stars kept", file=sys.stderr)
        sys.exit(1)

    n = len(kept)
    scale_pc = max_abs_coord / 32767.0
    max_dist_pc = max(math.sqrt(x*x + y*y + z*z) for x, y, z, _, _ in kept)

    # Fix name indices to final kept array indices
    name_table = []
    for idx, star in enumerate(kept):
        if star[4] is not None:
            # star[4] currently holds (original_index, utf8), we replace with final index
            orig_idx, utf8 = star[4]
            name_table.append((idx, utf8))
    name_count = len(name_table)

    # Prepare binary data
    header = struct.pack("<4sIffII", b"HYG2", n, scale_pc, max_dist_pc, name_count, name_bytes_total)

    xyz_data = []
    mag_data = []
    for x, y, z, mag, _ in kept:
        ix = int(round(x / scale_pc))
        iy = int(round(y / scale_pc))
        iz = int(round(z / scale_pc))
        ix = max(-32768, min(32767, ix))
        iy = max(-32768, min(32767, iy))
        iz = max(-32768, min(32767, iz))
        xyz_data.extend((ix, iy, iz))

        q = int(round((mag + 2.0) / 0.1))
        q = max(0, min(255, q))
        mag_data.append(q)

    xyz_bytes = struct.pack("<" + "h" * (n * 3), *xyz_data)
    mag_bytes = bytes(mag_data)

    name_bytes_list = []
    for idx, utf8 in name_table:
        name_bytes_list.append(struct.pack("<HB", idx, len(utf8)))
    name_block = b"".join(name_bytes_list) + b"".join(utf8 for idx, utf8 in name_table)

    full_data = header + xyz_bytes + mag_bytes + name_block

    # Write to temp file then atomic replace
    tmp = tempfile.NamedTemporaryFile(delete=False, dir=os.path.dirname(out_path), suffix=".tmp")
    try:
        tmp.write(full_data)
        tmp.close()
        os.replace(tmp.name, out_path)
        os.chmod(out_path, 0o644)
    except Exception:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass
        raise

    # Verification
    with open(out_path, "rb") as f:
        data = f.read()

    if len(data) != len(full_data):
        print("Verification failed: size mismatch", file=sys.stderr)
        sys.exit(1)

    magic, vn, vscale, vmaxd, vnamec, vnameb = struct.unpack_from("<4sIffII", data, 0)
    if magic != b"HYG2" or vn != n:
        print("Verification failed: header mismatch", file=sys.stderr)
        sys.exit(1)

    offset = 24
    xyz_read = struct.unpack_from("<" + "h" * (n * 3), data, offset)
    offset += n * 3 * 2
    mag_read = data[offset:offset + n]
    offset += n

    max_pos_error = 0.0
    for i in range(n):
        x, y, z, mag, _ = kept[i]
        rx = xyz_read[i*3]
        ry = xyz_read[i*3+1]
        rz = xyz_read[i*3+2]
        dec_x = rx * vscale
        dec_y = ry * vscale
        dec_z = rz * vscale
        err = math.sqrt((dec_x - x)**2 + (dec_y - y)**2 + (dec_z - z)**2)
        max_pos_error = max(max_pos_error, err)

        q = mag_read[i]
        dec_mag = -2.0 + q * 0.1
        if abs(dec_mag - mag) > 0.05 + 1e-6:
            print("Verification failed: magnitude error too large", file=sys.stderr)
            sys.exit(1)

    verify_names(data, n, name_count, name_bytes_total, name_table)

    file_size = len(data)

    print(f"{n} kept, {dropped} dropped, {name_count} named, "
          f"max_dist={max_dist_pc:.3f}pc, scale={scale_pc:.6f}, "
          f"{file_size} bytes, max_pos_err={max_pos_error:.6f}pc")


if __name__ == "__main__":
    main()
