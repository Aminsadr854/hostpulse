# hostpulse

Agentless server monitoring. Add a server from the panel with a password or an
SSH private key, and it is read once a minute over SSH — processor, memory,
disk, and how many bytes its interfaces moved.

Nothing is installed on the machines being watched. If you can `ssh` to it, you
can monitor it.

## Why

Most monitoring wants an agent on every box, a metrics port open, and a config
file edited by hand for each new machine. That is a reasonable trade for a fleet
you own end to end, and a poor one for a handful of rented servers across
several providers — where the number you actually want is *how much traffic did
this machine use this month*, and the provider's own panel is the least willing
to tell you.

hostpulse is one process and one SQLite file. Adding a server is a form.

## What it shows

- **Traffic** — today, last 7 days, last 30 days, in and out separately, in
  bytes, because that is the unit a provider bills in.
- **Bandwidth** — current throughput in bits per second, and a graph over
  1 hour / 6 hours / 24 hours / 7 days / 30 days. Rates use the 1000-step
  network convention (a 100 Mbps port reads as 100 Mbps, not 95).
- **Resources** — processor, memory and disk, live and over time.
- Load average, uptime, and the last error if a server stops answering.

Minute-resolution samples are kept for two days, hourly averages for four
months, and daily totals for ever. A year of history for twenty servers is a
few megabytes.

## Install

```bash
git clone https://github.com/YOURNAME/hostpulse.git
cd hostpulse
sudo ./install.sh
```

It listens on `127.0.0.1:8899` and is **not** exposed to the internet. Reach it
over an SSH tunnel:

```bash
ssh -N -L 8899:127.0.0.1:8899 root@your-server
```

then open <http://127.0.0.1:8899>. The first visit asks you to set a panel
password.

To publish it properly, put a reverse proxy with TLS in front — any of nginx,
Caddy or Apache will do. There is an example vhost in [`docs/`](docs/).

## Adding a server

Name, address, port, user, and then either a password or a private key (with a
passphrase if the key has one). **Test connection** tries the credentials and
reports the hostname, core count, memory and disk before you save, so a server
that will never connect is caught immediately rather than sitting grey on the
dashboard.

A read-only account is enough — everything comes from `/proc` and one `df`.

## How it reads a machine

One SSH command per poll, returning a few hundred bytes:

```
/proc/stat        processor time
/proc/meminfo     memory
/proc/net/dev     interface byte counters
df -P -B1 /       disk
/proc/loadavg     load
/proc/uptime      uptime
```

Byte counters are cumulative since boot, so what gets stored is the difference
between two readings. A reboot, an interface reset or a counter wrap shows up
as a decrease, and a decrease is recorded as no traffic rather than as a large
negative number that would corrupt every total containing it.

Loopback and virtual interfaces (`veth*`, `docker*`, `br-*`, `virbr*`) are
skipped, or container traffic would be counted twice.

## Security

- Credentials are encrypted at rest with a key in `data/secret.key`, mode 600,
  generated on first run. This does not defend against someone who already has
  root on the panel host — the service must be able to read the key — but a
  copied database, a stray backup or a disk snapshot is not a set of working
  logins.
- The panel password is stored as PBKDF2-SHA256, 200k iterations.
- Sessions are signed cookies; the signing key is generated on first run.
- The service binds to localhost by default.

If you restore the database without `secret.key`, stored credentials cannot be
decrypted and the panel says so plainly rather than failing later inside an SSH
handshake. Back up both files together.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `HOSTPULSE_BIND` | `127.0.0.1` | address to listen on |
| `HOSTPULSE_PORT` | `8899` | port |
| `HOSTPULSE_DB` | `/opt/hostpulse/data/hostpulse.db` | database |
| `HOSTPULSE_KEY` | `/opt/hostpulse/data/secret.key` | encryption key |

Poll interval and retention are constants at the top of `collector.py` and
`db.py`.

## Licence

MIT.
