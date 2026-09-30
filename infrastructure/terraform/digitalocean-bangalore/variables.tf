variable "do_token" {
  description = "DigitalOcean API token (use TF_VAR_do_token env var, never commit)"
  type        = string
  sensitive   = true
}

variable "environment" {
  type    = string
  default = "production"
}

variable "droplet_size" {
  type    = string
  default = "s-2vcpu-4gb"
}

variable "admin_username" {
  type    = string
  default = "atb"
}

variable "ssh_public_key" {
  type = string
}

variable "admin_cidrs" {
  type = list(string)
}
