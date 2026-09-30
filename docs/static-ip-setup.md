# Static IP setup (SEBI retail-algo rules)

Since 1 April 2026, broker **order** APIs (place / modify / cancel) accept requests only from a
whitelisted static IP. You can whitelist up to **2 IPs** (primary + secondary), and you can change
them only about **once a week**. Market-data and read APIs usually work from any IP. Some brokers
(for example Kotak Neo) also require the API **session** to be created from the same IP.

| Role      | Provider     | Region               | Static IP                                  | Node id       |
| --------- | ------------ | -------------------- | ------------------------------------------ | ------------- |
| Primary   | Azure        | Central India (Pune) | Standard static public IP on the NIC       | `azure-cin-1` |
| Secondary | DigitalOcean | Bangalore `blr1`     | Reserved IP, egress via the anchor gateway | `do-blr-1`    |

Only the node that holds the **execution lease** (managed by `TradingAccountDO` in Cloudflare) may
send orders. The other node stays on hot standby. If both are down, or both lose the lease, all
orders are blocked.

## 1. Provision

```bash
# Azure (primary)
cd infrastructure/terraform/azure-central-india
cp terraform.tfvars.example terraform.tfvars   # fill in subscription, SSH key, your admin IP
az login && terraform init && terraform apply
terraform output static_egress_ip              # -> PRIMARY IP

# DigitalOcean (secondary)
cd ../digitalocean-bangalore
cp terraform.tfvars.example terraform.tfvars
export TF_VAR_do_token=dop_v1_xxx
terraform init && terraform apply
terraform output static_egress_ip              # -> SECONDARY IP
```

> **DigitalOcean gotcha:** a Reserved IP handles only **inbound** traffic by default. Outbound traffic
> keeps using the droplet's own IP unless the default route goes through the anchor gateway. The
> cloud-init unit `atb-reserved-ip-egress.service` sets this route on every boot
> ([DO docs](https://docs.digitalocean.com/products/networking/reserved-ips/how-to/outbound-traffic/)).
> After the route changes, SSH to the **reserved IP**.

## 2. Verify egress BEFORE whitelisting

Do this on each VM:

```bash
./scripts/verify-egress.sh <that-node's-static-ip>
```

Whitelist an IP only when the script reports that all three IP-echo services return the expected IP.

## 3. Whitelist at the broker

Log in to the broker's developer console and add the primary IP, then the secondary IP. For Zerodha
this is under Kite Connect developer console → Profile → IP Whitelist. Take care here, because a
mistake locks you out of changes for about a week.

## 4. Deploy the gateway stack

```bash
ssh atb@<static-ip>
cd /opt/atb
# create .env from ../../.env.example (gateway + broker section), chmod 600 .env
# set GATEWAY_NODE_ID, WHITELISTED_EGRESS_IPS=<primary>,<secondary>, CONTROL_PLANE_URL, CLOUDFLARE_TUNNEL_TOKEN
docker compose -f docker-compose.prod.yml --env-file .env up -d
```

The gateway checks its egress IP when it starts and every minute after that. If the IP doesn't
match, it:

- sends `egressIpOk=false` in its heartbeat,
- the Worker locks risk (`EGRESS_IP_MISMATCH`),
- and all live orders are blocked.

## 5. Test order

During market hours, and in `CANARY` mode with the smallest possible size, place one LIMIT order far
away from LTP, then cancel it. Confirm that it appears in the broker order book with the expected
tag.
