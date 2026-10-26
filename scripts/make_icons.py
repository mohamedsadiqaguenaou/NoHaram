"""Draws the NoHaram icons into src/icons/ (same family as NoMusic: a symbol with a black slash).

  * logo.png       transparent brand mark for the popup: green eye + black slash
  * icon-<n>.png   toolbar / store icons: green rounded square, white eye + black slash
"""
import os

from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "icons")
S = 1024  # draw large, downsample for smooth edges
GREEN = (52, 199, 120, 255)  # #34c778
INK = (17, 17, 17, 255)
WHITE = (255, 255, 255, 255)


def eye(draw, box, fill, pupil):
    """Almond eye inside box = (x0, y0, x1, y1) built from two circle chords."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    # The almond is the intersection of two large circles; draw it as a polygon.
    import math
    pts = []
    r = (w * w / 4 + (h / 2) ** 2) / h  # circle radius through the corners and the top/bottom points
    cx = (x0 + x1) / 2
    for sign in (1, -1):  # upper arc then lower arc
        cy = (y0 + y1) / 2 + sign * (r - h / 2)
        half = math.asin((w / 2) / r)
        steps = 60
        for i in range(steps + 1):
            a = -half + 2 * half * i / steps
            if sign < 0:
                a = -a
            pts.append((cx + r * math.sin(a), cy - sign * r * math.cos(a)))
    draw.polygon(pts, fill=fill)
    iris = h * 0.30
    draw.ellipse([cx - iris, (y0 + y1) / 2 - iris, cx + iris, (y0 + y1) / 2 + iris], fill=pupil)
    dot = iris * 0.42
    draw.ellipse([cx - dot, (y0 + y1) / 2 - dot, cx + dot, (y0 + y1) / 2 + dot], fill=fill)


def slash(draw, width):
    draw.line([(S * 0.14, S * 0.86), (S * 0.86, S * 0.14)], fill=INK, width=width)
    r = width / 2  # round caps
    for x, y in ((S * 0.14, S * 0.86), (S * 0.86, S * 0.14)):
        draw.ellipse([x - r, y - r, x + r, y + r], fill=INK)


def logo():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    eye(d, (S * 0.06, S * 0.27, S * 0.94, S * 0.73), GREEN, WHITE)
    slash(d, int(S * 0.075))
    return im


def app_icon():
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.2), fill=GREEN)
    eye(d, (S * 0.13, S * 0.31, S * 0.87, S * 0.69), WHITE, GREEN)
    slash(d, int(S * 0.08))
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    logo().resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "logo.png"))
    icon = app_icon()
    for size in (16, 32, 48, 128):
        icon.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon-{size}.png"))
    print("icons written to", os.path.abspath(OUT))


if __name__ == "__main__":
    main()
