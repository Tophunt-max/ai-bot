output "static_egress_ip" {
  description = "SECONDARY IP to whitelist at your broker (egress goes via anchor gateway — verify with scripts/verify-egress.sh)"
  value       = digitalocean_reserved_ip.egress.ip_address
}

output "droplet_ip" {
  description = "Droplet's own IP (NOT the whitelisted one; used for SSH before reserved-ip routing)"
  value       = digitalocean_droplet.gw.ipv4_address
}
