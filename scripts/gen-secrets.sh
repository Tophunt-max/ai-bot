#!/usr/bin/env bash
# Generates strong random secrets. Paste them into `wrangler secret put` and the VM's /opt/atb/.env.
set -euo pipefail
gen() { if command -v openssl >/dev/null; then openssl rand -hex 32; else node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"; fi; }
echo "JWT_SECRET=$(gen)"
echo "GATEWAY_HMAC_SECRET=$(gen)"
echo "AI_SERVICE_SECRET=$(gen)"
echo
echo "# Owner password hash:  pnpm --filter @atb/api run hash-password -- '<long password>'"
