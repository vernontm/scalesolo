"""
HyperFrames SFX Generator
Generates all 42 sound effects for the HyperFrames template system
using the ElevenLabs Sound Effects API.

Usage:
    1. Install dependencies:
       pip install elevenlabs python-dotenv

    2. Create a .env file in the same directory with:
       ELEVENLABS_API_KEY=your_key_here

    3. Run:
       python generate_sfx.py

    4. Output: 42 MP3 files in ./sfx/ organized by category folder.

Cost estimate: ~$5-10 total at current ElevenLabs SFX pricing.
Runtime: ~10-15 minutes (sequential calls with brief pauses for rate limiting).
"""

import os
import time
from pathlib import Path
from dotenv import load_dotenv
from elevenlabs.client import ElevenLabs

load_dotenv()

API_KEY = os.getenv("ELEVENLABS_API_KEY")
if not API_KEY:
    raise SystemExit("Missing ELEVENLABS_API_KEY in .env file")

client = ElevenLabs(api_key=API_KEY)

# Output configuration
OUTPUT_ROOT = Path("./sfx")
OUTPUT_FORMAT = "mp3_44100_128"  # mp3 at 44.1kHz, 128kbps

# Global tonal direction baked into every prompt for consistency:
#   - Clean, modern, designed (not raw field recordings)
#   - Crisp transients, controlled tails
#   - Professional motion-graphics aesthetic
# This is the "house style" that makes all 42 sounds feel like one bank.

SFX_DEFINITIONS = [
    # ====================================================================
    # IMPACTS (8) — for entrances, stat reveals, lower thirds
    # ====================================================================
    {
        "id": "impact_soft",
        "category": "impacts",
        "duration": 0.4,
        "prompt": "A soft warm thud with subtle low sub-bass tail, single hit, clean transient, no reverb, designed UI sound effect, mono."
    },
    {
        "id": "impact_hard",
        "category": "impacts",
        "duration": 0.5,
        "prompt": "A sharp metallic hit with brief ring, single hard impact, industrial, brutalist, crisp transient, short tail, designed motion graphics SFX."
    },
    {
        "id": "impact_bass",
        "category": "impacts",
        "duration": 0.9,
        "prompt": "A deep cinematic boom with long sub-bass tail, premium impact, single hit, dramatic, like a movie title card reveal, controlled decay."
    },
    {
        "id": "pop_soft",
        "category": "impacts",
        "duration": 0.25,
        "prompt": "A clean bubble pop, mid-frequency, single bright pop with quick decay, designed UI sound, playful but professional, no reverb."
    },
    {
        "id": "pop_punch",
        "category": "impacts",
        "duration": 0.3,
        "prompt": "A compressed pop with low-end thump, single punchy hit, modern snappy UI sound, transient-forward, clean tail."
    },
    {
        "id": "slam_metal",
        "category": "impacts",
        "duration": 0.55,
        "prompt": "A heavy metallic slam, single impact like a door slamming or anvil hit, raw industrial brutalist sound, short ring."
    },
    {
        "id": "thud_paper",
        "category": "impacts",
        "duration": 0.35,
        "prompt": "Paper or thick card landing on wood, soft tactile thud, warm organic sound, single impact, no reverb."
    },
    {
        "id": "boom_sub",
        "category": "impacts",
        "duration": 0.7,
        "prompt": "A pure sub-bass drop with no transient attack, slow rising-then-decaying low frequency, sleek futuristic, like a tech product launch sound."
    },

    # ====================================================================
    # WHOOSHES (7) — for slides, transitions, motion accents
    # ====================================================================
    {
        "id": "swoosh_low",
        "category": "whooshes",
        "duration": 0.7,
        "prompt": "A slow cinematic air sweep, low-pass filtered whoosh, smooth deep tone, professional motion graphics transition sound, mono."
    },
    {
        "id": "swoosh_mid",
        "category": "whooshes",
        "duration": 0.45,
        "prompt": "A balanced whoosh sweep, mid-frequency air motion, clean designed transition sound, standard speed, professional UI."
    },
    {
        "id": "swoosh_fast",
        "category": "whooshes",
        "duration": 0.3,
        "prompt": "A quick high-frequency air sweep, snappy energetic whoosh, fast lateral motion sound, designed for rapid UI transitions."
    },
    {
        "id": "swoosh_riser",
        "category": "whooshes",
        "duration": 0.9,
        "prompt": "A rising pitch sweep building tension, cinematic riser, slow build with increasing frequency and intensity, designed for stat reveal build-ups."
    },
    {
        "id": "swoosh_drop",
        "category": "whooshes",
        "duration": 0.7,
        "prompt": "A descending pitch sweep, falling tone, resolution or ending feel, smooth downward motion sound, cinematic."
    },
    {
        "id": "whip_short",
        "category": "whooshes",
        "duration": 0.35,
        "prompt": "A short whip-crack swipe, fast punchy lateral whoosh, modern motion graphics transition, single sharp sweep."
    },
    {
        "id": "air_brush",
        "category": "whooshes",
        "duration": 0.55,
        "prompt": "A soft gentle brush of air, organic warm whoosh, like paper or fabric moving, subtle natural sweep sound."
    },

    # ====================================================================
    # UI / PINGS (6) — for emphasis, indicators, lower thirds
    # ====================================================================
    {
        "id": "ping_clean",
        "category": "ui",
        "duration": 0.8,
        "prompt": "A single clean bell ping, bright premium UI tone with smooth decay, like a notification or attention sound, designed and polished."
    },
    {
        "id": "ping_soft",
        "category": "ui",
        "duration": 0.9,
        "prompt": "A muted bell tone, soft gentle ping, calm UI notification sound, warm and unobtrusive, smooth decay."
    },
    {
        "id": "chime_short",
        "category": "ui",
        "duration": 0.7,
        "prompt": "A two-note ascending chime, brief notification sound, clean designed UI tones, professional and bright."
    },
    {
        "id": "tick",
        "category": "ui",
        "duration": 0.15,
        "prompt": "A single short mechanical click or tick, precise and dry, no tail, like a typewriter key or button click."
    },
    {
        "id": "notif_pop",
        "category": "ui",
        "duration": 0.35,
        "prompt": "A modern notification blip, bright social media app sound, single short pop with subtle tonal quality, designed UI."
    },
    {
        "id": "bell_brass",
        "category": "ui",
        "duration": 1.3,
        "prompt": "A warm brass bell tone, single elegant ring with long natural decay, editorial refined sound, like a hotel desk bell."
    },

    # ====================================================================
    # GLITCH / DIGITAL (6) — for VHS and broken-tech templates
    # ====================================================================
    {
        "id": "glitch_short",
        "category": "glitch",
        "duration": 0.3,
        "prompt": "A brief digital glitch, RGB tear sound, short electronic stutter with bit-crushed texture, VHS broken signal aesthetic."
    },
    {
        "id": "glitch_long",
        "category": "glitch",
        "duration": 0.7,
        "prompt": "An extended digital tear, longer glitch with multiple stutter artifacts, cyberpunk broken transmission sound, distorted electronic."
    },
    {
        "id": "static_burst",
        "category": "glitch",
        "duration": 0.25,
        "prompt": "A burst of white noise static, brief sharp TV interference sound, VHS tape static hit, harsh."
    },
    {
        "id": "static_loop_short",
        "category": "glitch",
        "duration": 1.0,
        "prompt": "One second of constant VHS tape static, looping seamlessly, low-level white noise texture with tape hiss, no transient peaks."
    },
    {
        "id": "vhs_rewind",
        "category": "glitch",
        "duration": 0.85,
        "prompt": "A VHS tape rewinding sound, mechanical whir with high-pitched tape motion, retro analog cassette aesthetic, nostalgic."
    },
    {
        "id": "bit_crush",
        "category": "glitch",
        "duration": 0.45,
        "prompt": "A distorted digital crunch, bit-crushed harsh artifact sound, glitchy electronic destruction effect, brief and harsh."
    },

    # ====================================================================
    # MECHANICAL / TACTILE (5) — for typewriter, brutalist, terminal
    # ====================================================================
    {
        "id": "type_key",
        "category": "mechanical",
        "duration": 0.1,
        "prompt": "A single typewriter keypress, vintage mechanical typewriter, sharp tactile click with metal action, no reverb."
    },
    {
        "id": "type_clack",
        "category": "mechanical",
        "duration": 0.12,
        "prompt": "A single mechanical keyboard keypress, modern Cherry MX-style switch, sharp clack sound, dry and percussive."
    },
    {
        "id": "paper_rustle",
        "category": "mechanical",
        "duration": 0.55,
        "prompt": "Paper shuffling or page turning, soft organic paper movement sound, editorial newspaper feel, natural and warm."
    },
    {
        "id": "wood_knock",
        "category": "mechanical",
        "duration": 0.25,
        "prompt": "A hollow wood tap, single knock on wooden surface, warm organic tactile sound, no reverb."
    },
    {
        "id": "stamp",
        "category": "mechanical",
        "duration": 0.4,
        "prompt": "A rubber stamp pressing onto paper, single authoritative thud with paper compression, brutalist editorial sound, no reverb."
    },

    # ====================================================================
    # CINEMATIC / ATMOSPHERIC (5) — for dramatic moments
    # ====================================================================
    {
        "id": "riser_short",
        "category": "cinematic",
        "duration": 1.1,
        "prompt": "A one-second rising tension build, cinematic riser with increasing pitch and intensity, leading into an impact, dramatic motion graphics."
    },
    {
        "id": "drone_hit",
        "category": "cinematic",
        "duration": 1.6,
        "prompt": "A sustained low cinematic drone strike, deep ominous tone with slow attack and long sustain, cinematic gravity, dark."
    },
    {
        "id": "swell_warm",
        "category": "cinematic",
        "duration": 1.3,
        "prompt": "A warm orchestral swell, strings or pad rising and falling, emotional editorial sound, smooth and refined, cinematic transition."
    },
    {
        "id": "dip_thud",
        "category": "cinematic",
        "duration": 0.7,
        "prompt": "A cinematic fade-to-black thud, soft low impact with subtle reverb tail, transition pause sound, like a chapter break."
    },
    {
        "id": "whoosh_cinematic",
        "category": "cinematic",
        "duration": 1.1,
        "prompt": "A long dramatic cinematic sweep, slow whoosh with deep low-end and airy high-end, premium movie transition sound."
    },

    # ====================================================================
    # STINGERS / HITS (5) — for end cards, CTAs, key moments
    # ====================================================================
    {
        "id": "sting_short",
        "category": "stingers",
        "duration": 0.65,
        "prompt": "A brief musical hit, single bright chord with quick decay, CTA emphasis sound, modern designed sting."
    },
    {
        "id": "sting_subscribe",
        "category": "stingers",
        "duration": 0.9,
        "prompt": "An affirmative ascending musical sting, three-note bright resolved chord progression, subscribe button or call-to-action emphasis."
    },
    {
        "id": "sting_logo",
        "category": "stingers",
        "duration": 1.3,
        "prompt": "A brand reveal hit, single bold designed chord with low-end weight and bright high-end, premium logo reveal sound, cinematic."
    },
    {
        "id": "sting_punch",
        "category": "stingers",
        "duration": 0.45,
        "prompt": "A quick musical punctuation hit, single sharp chord stab, stat reveal climax sound, snappy and confident."
    },
    {
        "id": "sting_resolve",
        "category": "stingers",
        "duration": 1.1,
        "prompt": "A resolution chord, warm satisfying musical ending hit, end card stinger, gentle but conclusive, like the end of a podcast intro."
    },
]


def generate_sfx(definition: dict) -> bytes:
    """Generate a single sound effect via ElevenLabs API.

    ElevenLabs requires duration_seconds >= 0.5. For ultra-short SFX
    (ticks, pops, key clicks) we request the API floor and rely on the
    bank.js duration_ms field to tell the worker the real playback
    length. The transient is in the first ~100ms anyway; the tail just
    sits below the noise floor.
    """
    requested_duration = max(0.5, float(definition["duration"]))
    response = client.text_to_sound_effects.convert(
        text=definition["prompt"],
        duration_seconds=requested_duration,
        prompt_influence=0.4,  # slightly higher than default 0.3 for tighter prompt adherence
        output_format=OUTPUT_FORMAT,
        model_id="eleven_text_to_sound_v2",
    )
    # The SDK returns a generator of bytes chunks
    return b"".join(response)


def main():
    OUTPUT_ROOT.mkdir(exist_ok=True)

    total = len(SFX_DEFINITIONS)
    print(f"Generating {total} sound effects...\n")

    for idx, sfx in enumerate(SFX_DEFINITIONS, start=1):
        category_dir = OUTPUT_ROOT / sfx["category"]
        category_dir.mkdir(exist_ok=True)
        output_path = category_dir / f"{sfx['id']}.mp3"

        if output_path.exists():
            print(f"[{idx:2d}/{total}] {sfx['id']:24s}  already exists, skipping")
            continue

        print(f"[{idx:2d}/{total}] {sfx['id']:24s}  generating ({sfx['duration']}s)...", end=" ", flush=True)

        try:
            audio_bytes = generate_sfx(sfx)
            output_path.write_bytes(audio_bytes)
            size_kb = len(audio_bytes) / 1024
            print(f"done ({size_kb:.0f} KB)")
        except Exception as e:
            print(f"FAILED: {e}")
            continue

        # Light pacing between calls to avoid hammering rate limits
        time.sleep(0.5)

    print(f"\nAll done. Files written to {OUTPUT_ROOT.resolve()}/")
    print("\nNext steps:")
    print("  1. Audition each file. Regenerate any that don't fit the vibe.")
    print("  2. To regenerate a single one, delete its file and re-run the script.")
    print("  3. Move /sfx/ into your project's /public/sfx/ directory.")
    print("  4. Normalize loudness across all 42 (Audacity batch -> Effect -> Loudness Normalization to -3 dB peak).")


if __name__ == "__main__":
    main()
