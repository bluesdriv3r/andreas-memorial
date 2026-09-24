# Execution role for the API function. The part URLs are signed with these
# credentials, so S3 authorizes each guest upload against this policy: PutObject
# (which covers create, upload-part and complete) only below uploads/, reading back
# the parts of an upload in progress, discarding an oversized one, and ListBucket for
# the admin file list. No GetObject, no DeleteObject.

data "aws_iam_policy_document" "api_assume" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "api" {
  name               = "${var.name_prefix}-api"
  assume_role_policy = data.aws_iam_policy_document.api_assume.json
}

data "aws_iam_policy_document" "api" {
  statement {
    sid    = "MultipartUploads"
    effect = "Allow"
    actions = [
      "s3:PutObject",
      "s3:ListMultipartUploadParts",
      "s3:AbortMultipartUpload",
    ]
    resources = ["${aws_s3_bucket.uploads.arn}/uploads/*"]
  }

  statement {
    sid       = "ListUploads"
    effect    = "Allow"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.uploads.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["uploads/*"]
    }
  }

  statement {
    sid       = "WriteLogs"
    effect    = "Allow"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.api.arn}:*"]
  }
}

resource "aws_iam_role_policy" "api" {
  name   = "memorial-upload-api"
  role   = aws_iam_role.api.id
  policy = data.aws_iam_policy_document.api.json
}
