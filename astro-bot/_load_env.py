"""Print `export KEY='VALUE'` lines for shell scripts — the safe way to load .env,
since python-dotenv (used everywhere else in this bot) tolerates unquoted spaces
that `set -a; . ./.env` chokes on."""
import shlex
from pathlib import Path
from dotenv import dotenv_values

for k, v in dotenv_values(Path(__file__).parent / ".env").items():
    if v is not None:
        print(f"export {k}={shlex.quote(v)}")
