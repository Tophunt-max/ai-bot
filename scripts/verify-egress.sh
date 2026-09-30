#!/usr/bin/env bash
# Run ON the gateway VM. Confirms outbound traffic leaves via the broker-whitelisted static IP.
#   ./scripts/verify-egress.sh 20.1.2.3            (Azure primary)
#   ./scripts/verify-egress.sh 139.59.1.2          (DO reserved IP)
set -euo pipefail
EXPECTED="${1:?usage: verify-egress.sh <whitelisted-ip>}"
fail=0
for url in https://api.ipify.org https://icanhazip.com https://ifconfig.me/ip; do
  ip=$(curl -4 -fsS --max-time 5 "$url" | tr -d '[:space:]' || echo "error")
  if [ "$ip" = "$EXPECTED" ]; then
    echo "OK    $url -> $ip"
  else
    echo "FAIL  $url -> $ip (expected $EXPECTED)"
    fail=1
  fi
done
if [ "$fail" -ne 0 ]; then
  echo "Egress IP mismatch: do NOT whitelist / trade from this host until fixed." >&2
  exit 1
fi
echo "Egress verified. Safe to whitelist $EXPECTED at the broker."
