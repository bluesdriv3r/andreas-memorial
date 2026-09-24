output "site_url" {
  description = "Public guest page — the address the QR code encodes."
  value       = local.site_url
}

output "admin_url" {
  description = "Admin download page, behind Basic Auth."
  value       = "${local.site_url}/admin/"
}

output "site_bucket" {
  description = "Bucket for the built pages. Consumed by ../publish.sh."
  value       = aws_s3_bucket.site.id
}

output "uploads_bucket" {
  description = "Bucket holding the guests' files below uploads/. Consumed by ../download.sh."
  value       = aws_s3_bucket.uploads.id
}

output "aws_region" {
  description = "Region of both buckets and the function."
  value       = var.aws_region
}

output "distribution_id" {
  description = "CloudFront distribution ID, for invalidations."
  value       = aws_cloudfront_distribution.site.id
}

output "function_url" {
  description = "Raw Lambda function URL. Must answer 403 when called directly — checked by ../verify.sh."
  value       = aws_lambda_function_url.api.function_url
}

output "event_title" {
  description = "Page header text. Injected into the MkDocs build by ../publish.sh."
  value       = var.event_title
}

output "footer_text" {
  description = "Footer text. Injected into the MkDocs build by ../publish.sh."
  value       = var.footer_text
}

output "upload_deadline" {
  description = "Time after which uploads are refused."
  value       = var.upload_deadline
}
