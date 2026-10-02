resource "random_id" "suffix" {
  byte_length = 4
}

locals {
  site_bucket_name    = "${var.name_prefix}-site-${random_id.suffix.hex}"
  uploads_bucket_name = "${var.name_prefix}-uploads-${random_id.suffix.hex}"

  site_origin_id    = "s3-site"
  uploads_origin_id = "s3-uploads"
  api_origin_id     = "lambda-api"

  site_url = "https://${aws_cloudfront_distribution.site.domain_name}"
}

# --- Origins: two private buckets, reachable only through CloudFront -------------

resource "aws_s3_bucket" "site" {
  bucket = local.site_bucket_name

  # Build output only; ../publish.sh regenerates it in one command.
  force_destroy = true
}

resource "aws_s3_bucket" "uploads" {
  bucket = local.uploads_bucket_name

  # The guests' photos. Deliberately NOT force_destroy: `terraform destroy` stops
  # with BucketNotEmpty instead of deleting them. Empty it by hand once the files
  # are safely downloaded — see README "Tearing Down".
  force_destroy = false
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket = aws_s3_bucket.site.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "site" {
  bucket = aws_s3_bucket.site.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

# Guests' browsers PUT multipart parts straight to the bucket's regional endpoint
# with presigned URLs from the Lambda. Only that one method, only from the page's
# own origin. The page never reads a response header, so nothing is exposed.
resource "aws_s3_bucket_cors_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  cors_rule {
    allowed_methods = ["PUT"]
    allowed_origins = [local.site_url]
    allowed_headers = ["*"]
    max_age_seconds = 3000
  }
}

# Parts of an upload that is never completed are invisible but billed. A guest who
# gives up, or anyone replaying part URLs, leaves such parts; they go after a day.
# Resuming works within that window.
resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  bucket = aws_s3_bucket.uploads.id

  rule {
    id     = "abort-incomplete-multipart-uploads"
    status = "Enabled"

    filter {
      prefix = "uploads/"
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }
}

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "${var.name_prefix}-s3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Only s3:GetObject, and only for this distribution. No s3:ListBucket, so a
# missing key returns 403 rather than 404.
data "aws_iam_policy_document" "site_origin" {
  statement {
    sid       = "AllowCloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.site.arn}/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id
  policy = data.aws_iam_policy_document.site_origin.json

  depends_on = [aws_s3_bucket_public_access_block.site]
}

# Read access for the admin originals under /admin/files/* (downloads, gallery and
# slideshow). The behavior that uses this origin is behind the admin session gate.
data "aws_iam_policy_document" "uploads_origin" {
  statement {
    sid       = "AllowCloudFrontRead"
    effect    = "Allow"
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.uploads.arn}/uploads/*"]

    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.site.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "uploads" {
  bucket = aws_s3_bucket.uploads.id
  policy = data.aws_iam_policy_document.uploads_origin.json

  depends_on = [aws_s3_bucket_public_access_block.uploads]
}

# --- Edge: admin session gate, cache and header policies --------------------------

resource "aws_cloudfront_function" "admin_auth" {
  name    = "${var.name_prefix}-admin-auth"
  runtime = "cloudfront-js-2.0"
  comment = "Session cookie check for /admin, path mapping for admin pages and originals"
  publish = true

  code = templatefile("${path.module}/admin-auth.js", {
    session_key = var.session_key
    admin_users = jsonencode(keys(var.admin_users))
  })
}

data "aws_cloudfront_cache_policy" "caching_optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

# Forwards the viewer's headers (including x-amz-content-sha256, which OAC needs
# for a POST body) but not Host — a Lambda function URL rejects a foreign Host.
data "aws_cloudfront_origin_request_policy" "all_viewer_except_host" {
  name = "Managed-AllViewerExceptHostHeader"
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${var.name_prefix}-security-headers"
  comment = "CSP, HSTS, nosniff, referrer and frame policy"

  security_headers_config {
    # Material for MkDocs emits inline <script> and <style> blocks and offers no
    # nonce hook, so 'unsafe-inline' cannot be avoided without a theme override.
    # Every external load is still confined to this origin and the uploads bucket's
    # regional endpoint, which the browser PUTs file parts to.
    content_security_policy {
      override = true

      content_security_policy = join("; ", [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline'",
        # Fonts are self-hosted (web/fonts/): no third party sees guests' requests.
        "font-src 'self'",
        "img-src 'self' data:",
        "object-src 'self'",
        "frame-src 'self'",
        "worker-src 'self'",
        "connect-src 'self' https://${aws_s3_bucket.uploads.bucket_regional_domain_name}",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'self'",
      ])
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = false
      preload                    = false
      override                   = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    frame_options {
      frame_option = "SAMEORIGIN"
      override     = true
    }
  }
}

# --- Distribution ---------------------------------------------------------------

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  is_ipv6_enabled     = true
  comment             = var.name_prefix
  default_root_object = "index.html"
  price_class         = var.price_class

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = local.site_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    domain_name              = aws_s3_bucket.uploads.bucket_regional_domain_name
    origin_id                = local.uploads_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }

  origin {
    # function_url is "https://<id>.lambda-url.<region>.on.aws/"; the origin wants the host.
    domain_name              = split("/", aws_lambda_function_url.api.function_url)[2]
    origin_id                = local.api_origin_id
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Order matters: CloudFront takes the first matching pattern.

  ordered_cache_behavior {
    path_pattern           = "/admin/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    # POST for /admin/api/delete; the body hash header OAC needs also stops CSRF.
    allowed_methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods  = ["GET", "HEAD"]

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.admin_auth.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/admin/files/*"
    target_origin_id       = local.uploads_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    # Large, one-off downloads: caching them at the edge only adds cost.
    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.admin_auth.arn
    }
  }

  ordered_cache_behavior {
    path_pattern           = "/admin*"
    target_origin_id       = local.site_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.admin_auth.arn
    }
  }

  # The public guest API: /api/config and /api/upload.
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = local.api_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer_except_host.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # The guest page and Material's assets. Public.
  default_cache_behavior {
    target_origin_id       = local.site_origin_id
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id            = data.aws_cloudfront_cache_policy.caching_optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
  }

  # Deliberately no custom_error_response: it applies to every behavior and would
  # replace the API's own 4xx JSON bodies with an HTML page.

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
