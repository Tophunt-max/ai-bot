variable "subscription_id" {
  description = "Azure subscription id"
  type        = string
}

variable "environment" {
  description = "staging | production"
  type        = string
  default     = "production"
}

variable "vm_size" {
  description = "2 vCPU / 4 GB is plenty for gateway + AI inference"
  type        = string
  default     = "Standard_B2s"
}

variable "admin_username" {
  type    = string
  default = "atb"
}

variable "ssh_public_key" {
  description = "Your SSH public key (ed25519 recommended)"
  type        = string
}

variable "admin_cidrs" {
  description = "CIDRs allowed to SSH (your home/office IP, e.g. [\"203.0.113.10/32\"])"
  type        = list(string)
}
