"""Regenerate desktop icons and the 400% installer sidebar from assets/logo.png."""

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont


def main():
    root = Path(__file__).resolve().parent
    source = Image.open(root.parent / "assets/logo.png").convert("RGB")
    bounds = ImageChops.difference(source, Image.new("RGB", source.size, "white")).getbbox()
    symbol = source.crop(bounds)

    # Keep the existing mark, with enough room to recognize it at 16–24 px.
    icon = Image.new("RGBA", (880, 880), "white")
    symbol.thumbnail((688, 688), Image.Resampling.LANCZOS)
    icon.paste(symbol, ((880 - symbol.width) // 2, (880 - symbol.height) // 2))
    mask = Image.new("L", icon.size)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, 879, 879), 156, fill=255)
    icon.putalpha(mask)
    sizes = [(size, size) for size in (16, 20, 24, 28, 32, 40, 48, 56, 64, 96, 128, 256)]
    for filename in ("logo.ico", "installer.ico"):
        icon.save(root / "assets" / filename, sizes=sizes, bitmap_format="bmp")

    # Four source pixels per logical pixel; NSIS resamples at the control's
    # actual size with HALFTONE, rather than stretching its stock 164×314 BMP.
    sidebar = Image.new("RGB", (656, 1256))
    draw = ImageDraw.Draw(sidebar)
    for y in range(sidebar.height):
        t = y / (sidebar.height - 1)
        draw.line((0, y, 655, y), fill=(round(17 + 5 * t), round(41 + 27 * t), round(56 + 21 * t)))
    mark = icon.resize((384, 384), Image.Resampling.LANCZOS)
    sidebar.paste(mark, (136, 292), mark)
    font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", 96)
    draw.text((328, 750), "YAB", font=font, fill=(240, 247, 248), anchor="mm")
    draw.line((248, 858, 408, 858), fill=(58, 199, 202), width=8)
    sidebar.save(root / "assets/installer-sidebar.bmp")


if __name__ == "__main__":
    main()
