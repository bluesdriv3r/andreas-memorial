# One small function serves the whole API: /api/config and /api/upload[/resume|
# /complete] (public) and /admin/api/list (behind the admin Basic Auth function).
# It never handles file bytes — guests PUT multipart parts straight to S3 with the
# presigned URLs it returns.

locals {
  function_name = "${var.name_prefix}-api"
}

data "archive_file" "api" {
  type        = "zip"
  source_file = "${path.module}/../lambda/index.mjs"
  output_path = "${path.module}/.build/api.zip"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${local.function_name}"
  retention_in_days = 14
}

resource "aws_lambda_function" "api" {
  function_name    = local.function_name
  role             = aws_iam_role.api.arn
  runtime          = "nodejs22.x"
  handler          = "index.handler"
  architectures    = ["arm64"]
  memory_size      = 256
  timeout          = 10
  filename         = data.archive_file.api.output_path
  source_code_hash = data.archive_file.api.output_base64sha256

  environment {
    variables = {
      UPLOADS_BUCKET  = aws_s3_bucket.uploads.id
      UPLOAD_DEADLINE = var.upload_deadline
      MAX_FILES       = tostring(var.max_files)
      MAX_PHOTO_BYTES = tostring(var.max_photo_mb * 1024 * 1024)
      MAX_VIDEO_BYTES = tostring(var.max_video_mb * 1024 * 1024)
    }
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

# AWS_IAM: the URL answers only SigV4-signed requests, which here means only
# CloudFront's origin access control. The raw lambda-url endpoint returns 403.
resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}

resource "aws_cloudfront_origin_access_control" "lambda" {
  name                              = "${var.name_prefix}-lambda"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront's OAC calls the function URL as the CloudFront service principal.
# The CloudFront developer guide ("Restrict access to an AWS Lambda function URL
# origin") grants both actions, each scoped to this distribution.
resource "aws_lambda_permission" "cloudfront_url" {
  statement_id  = "AllowCloudFrontInvokeFunctionUrl"
  action        = "lambda:InvokeFunctionUrl"
  function_name = aws_lambda_function.api.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
}

resource "aws_lambda_permission" "cloudfront_invoke" {
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
}
