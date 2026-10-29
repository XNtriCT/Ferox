import os
from PIL import Image

LOGO_FILL = 0.72  # head occupies this fraction of the square; keeps every
                  # tip inside circular launcher masks after rounding


def make_square(img: Image.Image, size: int) -> Image.Image:
    """Square canvas, transparent background, logo centered (aspect kept)."""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    target = int(size * LOGO_FILL)
    w, h = img.size
    scale = min(target / w, target / h)
    logo = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.Resampling.LANCZOS)
    canvas.paste(logo, ((size - logo.width) // 2, (size - logo.height) // 2), logo)
    return canvas


def generate_icons():
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    logo_path = os.path.join(base_dir, "logo.png")

    if not os.path.exists(logo_path):
        print(f"Error: {logo_path} not found")
        return

    img = Image.open(logo_path).convert("RGBA")

    # 1. Desktop Assets
    assets_dir = os.path.join(base_dir, "assets")
    os.makedirs(assets_dir, exist_ok=True)

    make_square(img, 512).save(os.path.join(assets_dir, "icon.png"), "PNG")

    ico = make_square(img, 256)
    ico_sizes = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)]
    ico.save(os.path.join(assets_dir, "icon.ico"), format="ICO", sizes=ico_sizes)

    # README / docs display logo (transparent, larger canvas)
    make_square(img, 600).save(os.path.join(assets_dir, "logo.png"), "PNG")
    print("Generated desktop icon.png, icon.ico, logo.png")

    # 2. Android Mipmap Icons
    res_dir = os.path.join(base_dir, "android", "app", "src", "main", "res")
    mipmap_configs = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }

    for folder, size in mipmap_configs.items():
        folder_path = os.path.join(res_dir, folder)
        os.makedirs(folder_path, exist_ok=True)
        square = make_square(img, size)
        square.save(os.path.join(folder_path, "ic_launcher.png"), "PNG")
        square.save(os.path.join(folder_path, "ic_launcher_round.png"), "PNG")
        print(f"Generated {folder} ({size}x{size})")

    drawable_dir = os.path.join(res_dir, "drawable")
    os.makedirs(drawable_dir, exist_ok=True)
    make_square(img, 128).save(os.path.join(drawable_dir, "app_logo.png"), "PNG")
    print("Generated Android drawables and mipmaps successfully!")


if __name__ == "__main__":
    generate_icons()
