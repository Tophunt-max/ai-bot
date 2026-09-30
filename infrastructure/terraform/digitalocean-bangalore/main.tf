# SECONDARY (standby) execution gateway: DigitalOcean Bangalore (blr1) + Reserved IP.
# NOTE: a DO Reserved IP is INBOUND-only by default. Outbound traffic keeps using the
# droplet's own IP unless the default route goes via the anchor gateway — cloud-init
# installs a systemd unit that does exactly that (see cloud-init/gateway.yaml.tftpl).

terraform {
  required_version = ">= 1.6"
  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.40"
    }
  }
}

provider "digitalocean" {
  token = var.do_token
}

locals {
  name = "atb-gw-${var.environment}-blr"
  tags = ["atb", "execution-gateway", var.environment]
}

resource "digitalocean_ssh_key" "admin" {
  name       = "${local.name}-admin"
  public_key = var.ssh_public_key
}

resource "digitalocean_droplet" "gw" {
  name       = local.name
  region     = "blr1"
  size       = var.droplet_size
  image      = "ubuntu-24-04-x64"
  ssh_keys   = [digitalocean_ssh_key.admin.fingerprint]
  monitoring = true
  ipv6       = false
  tags       = local.tags
  user_data = templatefile("${path.module}/../../cloud-init/gateway.yaml.tftpl", {
    admin_username = var.admin_username
    ssh_public_key = var.ssh_public_key
    node_id        = "do-blr-1"
    provider_name  = "digitalocean"
  })
}

# Keep the reserved IP even if the droplet is rebuilt — it is the broker-whitelisted SECONDARY IP.
resource "digitalocean_reserved_ip" "egress" {
  region = "blr1"

  lifecycle {
    prevent_destroy = true
  }
}

resource "digitalocean_reserved_ip_assignment" "egress" {
  ip_address = digitalocean_reserved_ip.egress.ip_address
  droplet_id = digitalocean_droplet.gw.id
}

resource "digitalocean_firewall" "gw" {
  name        = "${local.name}-fw"
  droplet_ids = [digitalocean_droplet.gw.id]

  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = var.admin_cidrs
  }

  outbound_rule {
    protocol              = "tcp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "udp"
    port_range            = "1-65535"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
  outbound_rule {
    protocol              = "icmp"
    destination_addresses = ["0.0.0.0/0", "::/0"]
  }
}
