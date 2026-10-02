variable "aws_region" {
  description = "Region for both buckets and the Lambda function. CloudFront itself is global."
  type        = string
  default     = "eu-central-1"
}

variable "name_prefix" {
  description = "Prefix for resource names. Buckets get a random suffix appended."
  type        = string
  default     = "memorial-upload"
}

variable "price_class" {
  description = "CloudFront edge coverage. PriceClass_100 is North America + Europe."
  type        = string
  default     = "PriceClass_100"

  validation {
    condition     = contains(["PriceClass_100", "PriceClass_200", "PriceClass_All"], var.price_class)
    error_message = "price_class must be PriceClass_100, PriceClass_200 or PriceClass_All."
  }
}

variable "admin_users" {
  description = <<-EOT
    Admin logins: username -> PBKDF2-SHA256 password hash
    ("pbkdf2_sha256$<iterations>$<salt hex>$<hash hex>"). Checked by the Lambda at
    POST /api/login. Written to auth.auto.tfvars.json by ../set-password.sh — never by hand.
  EOT
  type        = map(string)
  sensitive   = true

  validation {
    condition = length(var.admin_users) > 0 && alltrue([
      for name, hash in var.admin_users :
      can(regex("^[a-z0-9-]{1,32}$", name)) && can(regex("^pbkdf2_sha256\\$[0-9]{6,7}\\$[0-9a-f]{32}\\$[0-9a-f]{64}$", hash))
    ])
    error_message = "admin_users needs at least one user with a lowercase name and a valid hash. Run ../set-password.sh <username>."
  }
}

variable "admin_owners" {
  description = "Admins (keys of admin_users) who may also delete uploads. Written by ../set-password.sh --owner."
  type        = list(string)
  default     = []
}

variable "session_key" {
  description = <<-EOT
    HMAC key that signs the admin session cookie, shared by the Lambda (signs at login)
    and the CloudFront Function (verifies every /admin request). Written to
    auth.auto.tfvars.json by ../set-password.sh; a new key ends every session.
  EOT
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.session_key))
    error_message = "session_key must be 64 lowercase hex characters. Run ../set-password.sh."
  }
}

variable "session_hours" {
  description = "How long an admin login stays valid, in hours."
  type        = number
  default     = 12

  validation {
    condition     = var.session_hours >= 1 && var.session_hours <= 168
    error_message = "session_hours must be between 1 and 168."
  }
}

variable "upload_deadline" {
  description = "RFC 3339 timestamp after which the API refuses new uploads, e.g. 2026-10-03T23:59:00Z."
  type        = string

  validation {
    condition     = can(formatdate("YYYY", var.upload_deadline))
    error_message = "upload_deadline must be an RFC 3339 timestamp such as 2026-10-03T23:59:00Z."
  }
}

# A past deadline is valid syntax but leaves the page closed on arrival. A check
# only warns, so a later `terraform plan` after the event still works.
check "upload_deadline_in_future" {
  assert {
    condition     = timecmp(var.upload_deadline, plantimestamp()) > 0
    error_message = "upload_deadline ${var.upload_deadline} is not in the future — guests will see uploads as closed."
  }
}

variable "event_title" {
  description = "Shown in the page header (site_name). Kept in terraform.tfvars so names stay out of git."
  type        = string
  default     = "Erinnerungen teilen"
}

variable "footer_text" {
  description = "Small text at the bottom of every page (MkDocs copyright). Kept in terraform.tfvars."
  type        = string
  default     = ""
}

variable "max_files" {
  description = "Maximum number of files per upload request."
  type        = number
  default     = 20
}

variable "max_photo_mb" {
  description = "Maximum size of one photo, in MiB. Enforced by signed part lengths and at completion."
  type        = number
  default     = 50
}

variable "max_video_mb" {
  description = "Maximum size of one video, in MiB. Enforced by signed part lengths and at completion."
  type        = number
  default     = 300
}
