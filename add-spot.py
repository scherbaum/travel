#!/usr/bin/env python3
"""Add an Instagram post as a user spot to the Sicily travel planner."""
import json
import sys
import os
import subprocess
import shutil
import tempfile
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
SPOTS_FILE = SCRIPT_DIR / "user-spots.json"
IMAGES_DIR = SCRIPT_DIR / "images"
FETCH_SCRIPT = Path("/tmp/openclaw/openclaw-claude-skills-QE9XSp/openclaw-skills/skills/insta-to-paprika/scripts/fetch_instagram.py")

def main():
    if len(sys.argv) < 2:
        print("Usage: add-spot.py <instagram_url> [description] [lat] [lng]")
        sys.exit(1)

    url = sys.argv[1]
    custom_desc = sys.argv[2] if len(sys.argv) > 2 else None
    lat = float(sys.argv[3]) if len(sys.argv) > 3 else None
    lng = float(sys.argv[4]) if len(sys.argv) > 4 else None

    # Find fetch script (try common skill paths)
    fetch_script = None
    for candidate in [
        "/tmp/openclaw/openclaw-claude-skills-QE9XSp/openclaw-skills/skills/insta-to-paprika/scripts/fetch_instagram.py",
    ]:
        if os.path.exists(candidate):
            fetch_script = candidate
            break

    if not fetch_script:
        # Try to find it
        result = subprocess.run(["find", "/tmp/openclaw", "-name", "fetch_instagram.py"], capture_output=True, text=True)
        if result.stdout.strip():
            fetch_script = result.stdout.strip().split("\n")[0]

    if not fetch_script:
        print("ERROR: fetch_instagram.py not found")
        sys.exit(1)

    # Fetch Instagram data
    with tempfile.TemporaryDirectory() as tmpdir:
        result = subprocess.run(
            ["python3", fetch_script, url, "--output-dir", tmpdir],
            capture_output=True, text=True
        )
        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            print(f"ERROR fetching Instagram: {result.stdout}\n{result.stderr}")
            sys.exit(1)

        if not data.get("success"):
            print(f"ERROR: {data}")
            sys.exit(1)

        shortcode = data["shortcode"]
        caption = data.get("caption", "")
        username = data.get("username", "")
        image_path = data.get("image_path")

        # Copy image
        IMAGES_DIR.mkdir(exist_ok=True)
        dest_image = None
        if image_path and os.path.exists(image_path):
            dest = IMAGES_DIR / f"{shortcode}.jpg"
            shutil.copy(image_path, dest)
            dest_image = f"/images/{shortcode}.jpg"

        # Auto-generate description from first 200 chars of caption
        if not custom_desc:
            # Clean emoji and newlines
            desc_text = caption.replace('\n', ' ').strip()
            # Remove hashtags
            words = [w for w in desc_text.split() if not w.startswith('#')]
            desc_text = ' '.join(words)[:250]
            if len(desc_text) == 250:
                desc_text = desc_text[:247] + '...'
            custom_desc = desc_text

        # Detect tags from hashtags
        hashtags = [w.lstrip('#') for w in caption.split() if w.startswith('#')]
        # Map common hashtags to nice tags
        tag_map = {
            'sicilia': 'Sizilien', 'sicily': 'Sizilien', 'beach': 'Strand',
            'nature': 'Natur', 'history': 'Geschichte', 'food': 'Essen',
            'wine': 'Wein', 'travel': 'Reise', 'art': 'Kunst',
            'volcano': 'Vulkan', 'etna': 'Ätna', 'palermo': 'Palermo',
            'taormina': 'Taormina', 'siracusa': 'Syrakus', 'catania': 'Catania',
        }
        tags = list(set(tag_map.get(h.lower(), None) for h in hashtags[:5] if tag_map.get(h.lower())))[:3]
        if not tags:
            tags = ['Instagram', 'Sizilien']

        # Load existing spots
        if SPOTS_FILE.exists():
            with open(SPOTS_FILE) as f:
                spots = json.load(f)
        else:
            spots = []

        # Check for duplicate
        if any(s['id'] == shortcode for s in spots):
            print(f"Spot {shortcode} already exists, skipping.")
            print(json.dumps({"shortcode": shortcode, "exists": True}))
            return

        # Add new spot
        spot = {
            "id": shortcode,
            "name": caption.split('\n')[0][:60] or f"@{username}",
            "username": username,
            "source_url": url,
            "image": dest_image,
            "desc": custom_desc,
            "tags": tags,
            "lat": lat,
            "lng": lng,
            "category": "Instagram"
        }
        spots.append(spot)

        with open(SPOTS_FILE, 'w', encoding='utf-8') as f:
            json.dump(spots, f, ensure_ascii=False, indent=2)

        print(json.dumps({"success": True, "shortcode": shortcode, "name": spot["name"], "username": username, "image": dest_image}))

if __name__ == "__main__":
    main()
