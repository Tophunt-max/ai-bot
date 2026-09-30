output "static_egress_ip" {
  description = "PRIMARY IP to whitelist at your broker"
  value       = azurerm_public_ip.egress.ip_address
}

output "ssh" {
  value = "ssh ${var.admin_username}@${azurerm_public_ip.egress.ip_address}"
}
