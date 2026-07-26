import os
from dotenv import load_dotenv

load_dotenv()

BAR_USERNAME = os.getenv("BAR_USERNAME")
BAR_PASSWORD = os.getenv("BAR_PASSWORD")

BROWSER_CHANNEL = os.getenv("BROWSER_CHANNEL", "")
MAX_PARALLEL = int(os.getenv("MAX_PARALLEL", "5"))
PROFILE_NAME = os.getenv("PROFILE_NAME", "bar_profile")

BAR_API_BASE = os.getenv("BAR_API_BASE", "https://toolsmandi.com/bar")
PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

EXTENSION_PATH = os.path.join(PROJECT_DIR, "extension")
BAR_SESSION_FILE = os.path.join(PROJECT_DIR, ".bar_session")


INACTIVE_FAILED_HTML_KEYWORDS = (
    "your status is inactive",
    "failed to fetch data",
    "error fetching data",
)

INACTIVE_FAILED_HTML_DISPLAY_MAP = {
    "your status is inactive": "Your status is inactive",
    "failed to fetch data": "Failed to fetch data",
    "error fetching data": "Ahrefs temporarily failed to fetch data (retry later)",
}

SOCIAL_DOMAINS = [
    "facebook.com", "instagram.com", "tiktok.com", "linkedin.com", "pinterest.com",
    "gmail.com", "google.com", "accounts.google.com", "drive.google.com", "docs.google.com",
    "twitch.tv", "netflix.com", "amazon.com", "login.live.com", "discord.com", "youtube.com",
    "canva.com", "figma.com", "uber.com", "ebay.com", "outlook.com", "telegram.org, web.telegram.org"
]
