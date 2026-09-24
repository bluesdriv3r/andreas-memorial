terraform {
  # 1.5 is what `brew install terraform` pins to (the last MPL-licensed release), and
  # `check` blocks plus plantimestamp() (used in variables.tf) arrived in 1.5.
  # OpenTofu works too.
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.aws_region
}
