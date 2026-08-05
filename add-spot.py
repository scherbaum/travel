#!/usr/bin/env python3
"""Add an Instagram post as a user spot to the Sicily travel planner."""
import json, sys, os, subprocess, shutil, tempfile, time
from pathlib import Path

try:
    import requests
    HAS_REQUESTS = True
except ImportError:
    HAS_REQUESTS = False

SCRIPT_DIR = Path(__file__).parent
SPOTS_FILE = SCRIPT_DIR / "user-spots.json"
IMAGES_DIR = SCRIPT_DIR / "images"

LOCATION_HASHTAGS = {
    'palermo', 'monreale', 'cefalu', 'cefalù', 'trapani', 'erice', 'segesta',
    'selinunte', 'agrigento', 'catania', 'taormina', 'siracusa', 'syrakus',
    'noto', 'modica', 'ragusa', 'etna', 'vulcano', 'stromboli', 'lipari',
    'alcantara', 'marsala', 'sciacca', 'messina', 'milazzo', 'scopello',
    'castellammare', 'zingaro', 'sanvitolocapo',
}

def find_fetch_script():
    for candidate in [
        "/tmp/openclaw/openclaw-claude-skills-QE9XSp/openclaw-skills/skills/insta-to-paprika/scripts/fetch_instagram.py",
    ]:
        if os.path.exists(candidate):
            return candidate
    result = subprocess.run(["find", "/tmp/openclaw", "-name", "fetch_instagram.py"], capture_output=True, text=True)
    if result.stdout.strip():
        return result.stdout.strip().split("\n")[0]
    return None

def geocode(query, context="Sicily, Italy"):
    if not HAS_REQUESTS:
        return None, None
    url = "https://nominatim.openstreetmap.org/search"
    params = {"q": f"{query}, {context}", "format": "json", "limit": 1}
    headers = {"User-Agent": "travel-planner/1.0"}
    try:
        res = requests.get(url, params=params, headers=headers, timeout=6)
        data = res.json()
        if data:
            return float(data[0]['lat']), float(data[0]['lon'])
    except Exception:
        pass
    return None, None

def extract_location_from_hashtags(hashtags):
    for tag in hashtags:
        t = tag.lower().replace('_', '').replace('-', '')
        if t in LOCATION_HASHTAGS:
            return tag.capitalize()
    return None

def main():
    if len(sys.argv) < 2:
        print("Usage: add-spot.py <instagram_url> [description] [lat] [lng]")
        sys.exit(1)

    url = sys.argv[1]
    custom_desc = sys.argv[2] if len(sys.argv) > 2 else None
    lat = float(sys.argv[3]) if len(sys.argv) > 3 else None
    lng = float(sys.argv[4]) if len(sys.argv) > 4 else None

    fetch_script = find_fetch_script()
    if not fetch_script:
        print("ERROR: fetch_instagram.py not found")
        sys.exit(1)

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

        IMAGES_DIR.mkdir(exist_ok=True)
        dest_image = None
        if image_path and os.path.exists(image_path):
            dest = IMAGES_DIR / f"{shortcode}.jpg"
            shutil.copy(image_path, dest)
            dest_image = f"/images/{shortcode}.jpg"

        hashtags = [w.lstrip('#') for w in caption.split() if w.startswith('#')]

        if not custom_desc:
            desc_text = caption.replace('\n', ' ').strip()
            words = [w for w in desc_text.split() if not w.startswith('#')]
            desc_text = ' '.join(words)[:250]
            if len(desc_text) == 250:
                desc_text = desc_text[:247] + '...'
            custom_desc = desc_text

        tag_map = {
            'sicilia': 'Sizilien', 'sicily': 'Sizilien', 'beach': 'Strand',
            'nature': 'Natur', 'history': 'Geschichte', 'food': 'Essen',
            'wine': 'Wein', 'travel': 'Reise', 'art': 'Kunst',
            'volcano': 'Vulkan', 'etna': 'Ätna', 'palermo': 'Palermo',
            'taormina': 'Taormina', 'siracusa': 'Syrakus', 'catania': 'Catania',
            'agrigento': 'Agrigento', 'noto': 'Noto', 'modica': 'Modica',
            'ragusa': 'Ragusa', 'cefalu': 'Cefalù', 'cefalù': 'Cefalù',
            'stromboli': 'Stromboli', 'lipari': 'Liparische Inseln',
            'hiking': 'Wandern', 'swimming': 'Baden', 'sea': 'Meer',
            'architecture': 'Architektur', 'baroque': 'Barock',
        }
        tags = list(dict.fromkeys(
            tag_map[h.lower()] for h in hashtags[:10] if h.lower() in tag_map
        ))[:3]
        if not tags:
            tags = ['Instagram', 'Sizilien']

        # Geocode from hashtags if no coordinates given
        if lat is None and lng is None:
            loc = extract_location_from_hashtags(hashtags)
            if loc:
                print(f"Geocoding: {loc}, Sicily ...", file=sys.stderr)
                lat, lng = geocode(loc)
                if lat:
                    print(f"  → {lat:.4f}, {lng:.4f}", file=sys.stderr)
                else:
                    print(f"  → nicht gefunden", file=sys.stderr)
                time.sleep(1)

        if SPOTS_FILE.exists():
            with open(SPOTS_FILE) as f:
                spots = json.load(f)
        else:
            spots = []

        if any(s['id'] == shortcode for s in spots):
            print(json.dumps({"shortcode": shortcode, "exists": True}))
            return

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

        print(json.dumps({
            "success": True, "shortcode": shortcode, "name": spot["name"],
            "username": username, "image": dest_image,
            "lat": lat, "lng": lng, "geocoded": lat is not None
        }))

if __name__ == "__main__":
    main()
