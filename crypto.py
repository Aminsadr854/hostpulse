"""
Credentials at rest.

The panel holds passwords and private keys for every machine it watches, which
makes its database the most valuable file on the host. Encrypting it does not
help against someone who already has root - the key has to be readable by the
service - but it does mean a stray backup, a copied database, or a snapshot
handed to someone else is not a set of working logins.

The key lives in its own file with mode 600, created on first run.
"""
import os

from cryptography.fernet import Fernet, InvalidToken

KEY_PATH = os.environ.get("HOSTPULSE_KEY", "/opt/hostpulse/data/secret.key")


def _key() -> bytes:
    if os.path.exists(KEY_PATH):
        return open(KEY_PATH, "rb").read().strip()
    os.makedirs(os.path.dirname(KEY_PATH), exist_ok=True)
    k = Fernet.generate_key()
    fd = os.open(KEY_PATH, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(k)
    return k


_f = None


def _fernet() -> Fernet:
    global _f
    if _f is None:
        _f = Fernet(_key())
    return _f


def encrypt(value: str) -> str:
    if value is None:
        return None
    return _fernet().encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    if not value:
        return ""
    try:
        return _fernet().decrypt(value.encode()).decode()
    except InvalidToken:
        # A database restored without its key file. Say so plainly rather than
        # failing later inside an SSH handshake with a confusing error.
        raise RuntimeError(
            "stored credential cannot be decrypted - secret.key does not match "
            "this database")
