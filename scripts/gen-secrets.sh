#!/usr/bin/env bash
# Generates strong random secrets. Paste them into `wrangler secret put` and the VM's /opt/atb/.env.
set -euo pipefail
gen() { openssl rand -hex 32; }
echo "JWT_SECRET=$(gen)"
echo "GATEWAY_HMAC_SECRET=$(gen)"
echo "AI_SERVICE_SECRET=$(gen)"
echo
echo "# Owner password hash:  pnpm --filter @atb/api run hash-password -- '<long password>'"
