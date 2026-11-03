output "aws_region" {
  value = var.aws_region
}
output "cluster_name" {
  value = module.eks.cluster_name
}
output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}
output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}
output "ecr_repository_name" {
  value = aws_ecr_repository.app.name
}
output "vpc_id" {
  value = module.vpc.vpc_id
}
