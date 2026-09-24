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

variable "credential_sha256" {
  description = <<-EOT
    Hex SHA-256 digest of the base64-encoded "user:password" Basic Auth token for the
    admin area. Written to auth.auto.tfvars by ../set-password.sh — never set it by hand.
  EOT
  type        = string
  sensitive   = true

  validation {
    condition     = can(regex("^[0-9a-f]{64}$", var.credential_sha256))
    error_message = "credential_sha256 must be 64 lowercase hex characters. Run ../set-password.sh."
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
