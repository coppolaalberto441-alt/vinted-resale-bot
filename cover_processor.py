"""Background-only cover: original RGB pixels, no generation or retouching.

Runs on CPU. Models only predict a mask; they never supply garment pixels.
"""
from __future__ import annotations

import io
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

MAX_BYTES = 8 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 16_000_000


class UnsafeMask(ValueError):
    pass


def composite_cover(source: Image.Image, mask: Image.Image) -> tuple[Image.Image, dict]:
    """Crop/translate only: fully opaque foreground is bit-for-bit original RGB."""
    source = ImageOps.exif_transpose(source).convert('RGB')
    if mask.size != source.size:
        raise UnsafeMask('Dimensioni maschera non corrispondenti')
    alpha = np.asarray(mask.convert('L')).copy()
    coverage = float(np.mean(alpha >= 128))
    if not 0.08 <= coverage <= 0.93:
        raise UnsafeMask('Scontorno incerto: area del soggetto non plausibile')
    # Snap confident regions only. Do not decontaminate/recolour the RGB image.
    alpha[alpha >= 245] = 255
    alpha[alpha <= 10] = 0
    bounds = Image.fromarray((alpha >= 128).astype('uint8') * 255).getbbox()
    if not bounds:
        raise UnsafeMask('Soggetto non individuato')
    x0, y0, x1, y1 = bounds
    # Keep all nonzero edges, not just the opaque interior.
    soft_bounds = Image.fromarray(alpha).getbbox()
    left, top, right, bottom = soft_bounds
    pad = max(24, round(max(right-left, bottom-top) * 0.07))
    width = max(source.width, right-left + 2*pad)
    height = max(source.height, bottom-top + 2*pad, round(width * 4/3))
    if width > 4096 or height > 4096:
        raise UnsafeMask('Immagine troppo grande: invia una foto Telegram, non un documento enorme')
    offset = ((width-(right-left))//2, (height-(bottom-top))//2)
    foreground = source.crop(soft_bounds).convert('RGBA')
    foreground.putalpha(Image.fromarray(alpha).crop(soft_bounds))
    canvas = Image.new('RGB', (width, height), (247, 247, 247))
    canvas.paste(foreground, offset, foreground)
    edge_touch = x0 <= 1 or y0 <= 1 or x1 >= source.width-1 or y1 >= source.height-1
    return canvas, {'coverage': round(coverage, 3), 'source_bounds': list(soft_bounds),
                    'offset': list(offset), 'edge_touch': edge_touch,
                    'warning': 'Controlla bordi, parti mancanti e residui di sfondo. Ombre e pieghe originali non vengono eliminate.'}


def process_bytes(data: bytes, session=None) -> tuple[bytes, dict]:
    if len(data) > MAX_BYTES:
        raise UnsafeMask('Foto oltre 8 MB')
    with Image.open(io.BytesIO(data)) as opened:
        source = ImageOps.exif_transpose(opened).convert('RGB')
    from rembg import new_session, remove
    session = session or new_session('isnet-general-use', providers=['CPUExecutionProvider'])
    mask = remove(source, session=session, only_mask=True, post_process_mask=False)
    output, report = composite_cover(source, mask)
    buffer = io.BytesIO()
    output.save(buffer, format='PNG', optimize=True)
    encoded = buffer.getvalue()
    if len(encoded) > MAX_BYTES:
        raise UnsafeMask('Risultato oltre 8 MB')
    return encoded, report


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Uso: python cover_processor.py ORIGINALE OUTPUT.png')
    os.environ.setdefault('OMP_NUM_THREADS', '2')
    result, report = process_bytes(Path(sys.argv[1]).read_bytes())
    Path(sys.argv[2]).write_bytes(result)
    print(json.dumps(report))
