"""One Sarvam chat completion with sarvam-105b-conversations. Run: python sarvam/chat_test.py"""
import os
import sys
from pathlib import Path

from sarvamai import SarvamAI

# Load sarvam/.env into the environment (no extra dependency); a key already set in the environment wins.
env_file = Path(__file__).with_name(".env")
if env_file.exists():
    for line in env_file.read_text(encoding="utf-8").splitlines():
        name, sep, value = line.partition("=")
        if sep and name.strip() and not name.strip().startswith("#"):
            os.environ.setdefault(name.strip(), value.strip().strip('"').strip("'"))

key = os.environ.get("SARVAM_API_KEY", "")
if not key or key == "paste-your-sarvam-key-here":
    sys.exit("SARVAM_API_KEY is empty: paste your key into sarvam/.env first.")

client = SarvamAI(api_subscription_key=key)
response = client.chat.completions(
    model="sarvam-105b-conversations",
    messages=[{"role": "user", "content": "Say hello in Hindi and English, in one short line."}],
)
print(response.choices[0].message.content)
