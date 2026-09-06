"""Initialize private deployment settings without printing secrets.

Run on the bank server against its existing private deployment environment.
Existing model/database settings are preserved; the shared service credential
is generated once. An omitted allow-list leaves enrollment unchanged/closed.
"""
import argparse
import os
import re
import secrets
import tempfile
from pathlib import Path


def configure(path: Path, allowed: str | None):
    if path.is_symlink() or not path.is_file():
        raise ValueError("Expected existing regular private environment file")
    source = path.read_text()
    values = dict(line.split("=", 1) for line in source.splitlines() if "=" in line and not line.startswith("#"))
    updates = {}
    if not values.get("NANOBOT_SERVICE_TOKEN"):
        updates["NANOBOT_SERVICE_TOKEN"] = secrets.token_urlsafe(48)
    if allowed is not None:
        if any(not re.fullmatch(r"(?:1\d{10}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})", item) for item in allowed.split(",") if item):
            raise ValueError("Allow-list must contain exact phones or customer UUIDs")
        updates["NANOBOT_ALLOWED_USERS"] = allowed
    elif "NANOBOT_ALLOWED_USERS" not in values:
        updates["NANOBOT_ALLOWED_USERS"] = ""
    if not updates:
        print("Nanobot private settings already initialized.")
        return
    lines = [line for line in source.splitlines() if line.split("=", 1)[0] not in updates]
    lines.extend(f"{key}={value}" for key, value in updates.items())
    descriptor, temporary = tempfile.mkstemp(prefix=".nanobot-env-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write("\n".join(lines) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    print("Nanobot private settings updated; no credential values were printed.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--allow-users", help="Comma-separated exact customer IDs/phones; empty closes enrollment")
    args = parser.parse_args()
    configure(args.env_file, args.allow_users)
