variable "aws_region" {
  description = "AWS region for all resources."
  type        = string
  default     = "ap-south-1"
}
variable "project_name" {
  type    = string
  default = "cloudcart"
}
variable "environment" {
  type    = string
  default = "dev"
}
variable "cluster_version" {
  description = "EKS Kubernetes version supported by the selected AWS region."
  type        = string
  default     = "1.33"
}
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
variable "public_subnet_cidrs" {
  type    = list(string)
  default = ["10.40.0.0/20", "10.40.16.0/20"]
}
variable "private_subnet_cidrs" {
  type    = list(string)
  default = ["10.40.128.0/20", "10.40.144.0/20"]
}
variable "node_instance_types" {
  type    = list(string)
  default = ["c7i-flex.large"]
}
variable "node_desired_size" {
  type    = number
  default = 2
}
variable "node_min_size" {
  type    = number
  default = 2
}
variable "node_max_size" {
  type    = number
  default = 3
}
variable "enable_nat_gateway" {
  description = "NAT gateways incur hourly and data-processing charges. Set false only if you have another private-subnet egress path."
  type        = bool
  default     = true
}
