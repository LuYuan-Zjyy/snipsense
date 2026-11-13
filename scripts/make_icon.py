"""Generate media/icon.png without external design tools."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

SCALE = 1
SIZE = 1024
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "media" / "icon.png"


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def vertical_gradient(size: int, top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        ratio = y / max(1, size - 1)
        color = tuple(round(top[i] + (bottom[i] - top[i]) * ratio) for i in range(3))
        draw.line((0, y, size, y), fill=color)
    return image


def main() -> None:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    mask = rounded_mask(SIZE, 220 * SCALE)
    background = vertical_gradient(SIZE, (7, 13, 24), (18, 33, 56)).convert("RGBA")
    canvas.paste(background, (0, 0), mask)

    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse(
        (520 * SCALE, -300 * SCALE, 1280 * SCALE, 420 * SCALE),
        fill=(56, 189, 248, 70),
    )
    glow_draw.ellipse(
        (-260 * SCALE, 560 * SCALE, 520 * SCALE, 1280 * SCALE),
        fill=(110, 231, 183, 45),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(110 * SCALE))
    canvas = Image.alpha_composite(canvas, Image.composite(glow, Image.new("RGBA", canvas.size), mask))

    draw = ImageDraw.Draw(canvas)
    draw.rounded_rectangle(
        (10 * SCALE, 10 * SCALE, SIZE - 10 * SCALE, SIZE - 10 * SCALE),
        radius=210 * SCALE,
        outline=(56, 96, 140, 155),
        width=2 * SCALE,
    )

    mint = (110, 231, 183, 255)
    sky = (96, 165, 250, 255)
    slate = (148, 163, 184, 185)

    draw.line(
        [(402 * SCALE, 330 * SCALE), (270 * SCALE, 512 * SCALE), (402 * SCALE, 694 * SCALE)],
        fill=mint,
        width=70 * SCALE,
        joint="curve",
    )
    draw.line(
        [(622 * SCALE, 330 * SCALE), (754 * SCALE, 512 * SCALE), (622 * SCALE, 694 * SCALE)],
        fill=sky,
        width=70 * SCALE,
        joint="curve",
    )
    draw.line(
        [(562 * SCALE, 300 * SCALE), (462 * SCALE, 724 * SCALE)],
        fill=slate,
        width=48 * SCALE,
    )
    draw.line(
        [(562 * SCALE, 300 * SCALE), (462 * SCALE, 724 * SCALE)],
        fill=(226, 232, 240, 70),
        width=14 * SCALE,
    )

    sparkle = [
        (764 * SCALE, 222 * SCALE),
        (784 * SCALE, 278 * SCALE),
        (840 * SCALE, 298 * SCALE),
        (784 * SCALE, 318 * SCALE),
        (764 * SCALE, 374 * SCALE),
        (744 * SCALE, 318 * SCALE),
        (688 * SCALE, 298 * SCALE),
        (744 * SCALE, 278 * SCALE),
    ]
    draw.polygon(sparkle, fill=(226, 248, 239, 255))
    draw.ellipse(
        (746 * SCALE, 280 * SCALE, 782 * SCALE, 316 * SCALE),
        fill=(255, 255, 255, 235),
    )

    icon = canvas.resize((256, 256), Image.Resampling.LANCZOS)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    icon.save(OUT, "PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
