"""
G1BK v1 format (Gaia DR3 HEALPix star packs)

Header (12 bytes): b"G1BK" u8(version=1) u8(order) u8(parent_order) u8(0) u32(n_cells LE)
Table: n_cells * 20 bytes: u32(local) u32(start) u32(count) u32(byte_offset) u32(byte_len)
Body: one zlib stream per cell (level-9) of 10 transposed byte planes.
Empty cells have byte_len=0.
"""

import zlib
import struct
import numpy as np


MAGIC = b"G1BK"
VERSION = 1
Q10_BYTES = 10
Q8PK_MAGIC = b"Q8PK"
MAX_CELLS = 99_999


def encode_cell(q10: np.ndarray) -> bytes:
    if q10.size == 0:
        return b""
    assert q10.dtype == np.uint8 and q10.ndim == 2 and q10.shape[1] == 10
    planes = [q10[:, j].tobytes() for j in range(10)]
    raw = b"".join(planes)
    return zlib.compress(raw, level=9)


def decode_cell(blob: bytes, count: int) -> np.ndarray:
    if count == 0:
        if blob:
            raise ValueError("non-empty blob for count=0")
        return np.zeros((0, 10), dtype=np.uint8)
    try:
        inflated = zlib.decompress(blob)
    except zlib.error as e:
        raise ValueError("corrupt zlib data in cell") from e
    if len(inflated) != Q10_BYTES * count:
        raise ValueError(f"inflated length {len(inflated)} != {Q10_BYTES*count}")
    arr = np.frombuffer(inflated, dtype=np.uint8).reshape((10, count)).T.copy()
    return arr


def pack_bytes(order: int, parent_order: int, cells):
    cells = sorted(cells, key=lambda x: x[0])  # by local
    header = struct.pack("<4sBBBBI", MAGIC, VERSION, order, parent_order, 0, len(cells))
    table = []
    body_parts = []
    start = 0
    body_offset = 0
    for local, q10 in cells:
        if q10.size == 0:
            n = 0
            blob = b""
        else:
            if not (q10.dtype == np.uint8 and q10.ndim == 2 and q10.shape[1] == 10):
                raise ValueError(f"cell {local}: expected uint8 array of shape (n, 10), got {q10.dtype} {q10.shape}")
            n = q10.shape[0]
            blob = encode_cell(q10)
        if n > 0 and len(blob) == 0:
            raise ValueError(f"cell {local} has count>0 but byte_len==0")
        table.append(struct.pack("<IIIII", local, start, n, body_offset, len(blob)))
        body_parts.append(blob)
        start += n
        body_offset += len(blob)
    table_bytes = b"".join(table)
    body = b"".join(body_parts)
    return header + table_bytes + body


def is_g1b(buf: bytes) -> bool:
    return len(buf) >= 4 and buf[:4] == MAGIC


def read_pack_bytes(buf: bytes):
    if not buf:
        raise ValueError("empty buffer")
    if buf[:4] == Q8PK_MAGIC:
        magic, order, parent_order, _, n_cells = struct.unpack_from("<4sBBHI", buf, 0)
        if n_cells > MAX_CELLS:
            raise ValueError("pack header size")
        if len(buf) < 12 + 12 * n_cells:
            raise ValueError("truncated pack table")
        offset = 12 + 12 * n_cells
        cells = []
        for i in range(n_cells):
            local, start, count = struct.unpack_from("<III", buf, 12 + 12 * i)
            cells.append((local, start, count))
        payload = np.frombuffer(buf[offset:], dtype=np.uint8).copy()
        return {"magic": "Q8PK", "version": 0, "order": order, "parent_order": parent_order,
                "cells": cells, "payload": payload}
    if buf[:4] != MAGIC:
        raise ValueError("bad magic")
    version, order, parent_order, _, n_cells = struct.unpack_from("<BBBBI", buf, 4)
    if version != VERSION:
        raise ValueError(f"unsupported version {version}")
    if n_cells > MAX_CELLS:
        raise ValueError("pack header size")
    if len(buf) < 12 + 20 * n_cells:
        raise ValueError("truncated pack table")
    offset = 12 + 20 * n_cells
    cells = []
    for i in range(n_cells):
        local, start, count, boff, blen = struct.unpack_from("<IIIII", buf, 12 + 20 * i)
        cells.append((local, start, count))
    payload_parts = []
    for i in range(n_cells):
        _, _, count, boff, blen = struct.unpack_from("<IIIII", buf, 12 + 20 * i)
        if count > 0 and blen == 0:
            raise ValueError("cell has count>0 and byte_len==0")
        if blen:
            if offset + boff + blen > len(buf):
                raise ValueError(f"cell {i} body out of range")
            cell_blob = buf[offset + boff:offset + boff + blen]
            dec = decode_cell(cell_blob, count)
            payload_parts.append(dec.tobytes())
    payload = np.frombuffer(b"".join(payload_parts), dtype=np.uint8).copy()
    return {"magic": "G1BK", "version": version, "order": order, "parent_order": parent_order,
            "cells": cells, "payload": payload}
