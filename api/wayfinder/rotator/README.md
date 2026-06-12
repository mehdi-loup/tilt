# Vendored: stablecoin-yield-rotator (Wayfinder path)

Copy of `paths/stablecoin-yield-rotator/scripts/` from the wayfinder-paths SDK
repo, path version 0.1.5 (`wfpath.yaml`). Do not edit these files here — resync
from the SDK checkout when the path version bumps.

`execute.py` loads `scripts/main.py` directly and calls its action functions
in-process with a per-request config dict (no `inputs/config.yaml`). Signing is
bridged to Privy by patching the SDK's wallet-label resolution — see the
"Stablecoin Yield Rotator" section in `execute.py`.

The scan cache the path writes (`inputs/.scan_cache/` next to `scripts/`) is
wallet-agnostic market data; sharing it across requests is intentional.
