# -*- coding: utf-8 -*-
"""Gera os ícones do PWA (roda uma vez; não faz parte da rotina diária)."""
import os
from PIL import Image, ImageDraw

RED = (230, 57, 75)
DARK = (178, 30, 47)


def gradiente(size):
    img = Image.new("RGB", (size, size), RED)
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * size)
            px[x, y] = (
                int(RED[0] * (1 - t) + DARK[0] * t),
                int(RED[1] * (1 - t) + DARK[1] * t),
                int(RED[2] * (1 - t) + DARK[2] * t),
            )
    return img


def triangulo(draw, size, cx, cy, r):
    draw.polygon([(cx - r * 0.55, cy - r), (cx - r * 0.55, cy + r),
                  (cx + r * 0.9, cy)], fill="white")


def icone(size, maskable=False):
    img = gradiente(size).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    if maskable:
        d.rectangle([0, 0, size, size], fill=255)
    else:
        d.rounded_rectangle([0, 0, size, size], radius=int(size * 0.22), fill=255)
    img.putalpha(mask)
    draw = ImageDraw.Draw(img)
    margem = size * (0.32 if maskable else 0.28)
    cx, cy = size / 2 - size * 0.02, size / 2
    r = (size - 2 * margem) / 2
    triangulo(draw, size, cx, cy, r)
    return img


def main():
    os.makedirs("icons", exist_ok=True)
    icone(192).save("icons/icon-192.png")
    icone(512).save("icons/icon-512.png")
    icone(512, maskable=True).save("icons/maskable-512.png")
    icone(180).save("icons/apple-touch-icon.png")
    icone(32).save("icons/favicon-32.png")
    print("Ícones gerados em icons/")


if __name__ == "__main__":
    main()
