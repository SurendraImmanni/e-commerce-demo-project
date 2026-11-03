# Terraform infrastructure

This configuration creates a VPC with public/private subnets in two AZs, one NAT Gateway by default, an immutable ECR repository, an EKS cluster, and an EKS managed node group.

## Bootstrap the remote state bucket first

Create a dedicated S3 bucket in the same or a suitable region, with versioning and default encryption enabled. Block all public access and limit access to the Terraform role. Example (replace the bucket name; it must be globally unique):

```bash
aws s3api create-bucket --bucket YOUR-UNIQUE-STATE-BUCKET --region ap-south-1 --create-bucket-configuration LocationConstraint=ap-south-1
aws s3api put-public-access-block --bucket YOUR-UNIQUE-STATE-BUCKET --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning --bucket YOUR-UNIQUE-STATE-BUCKET --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket YOUR-UNIQUE-STATE-BUCKET --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

Update `backend.hcl.example`, save it as `backend.hcl`, and replace the bucket name. S3 native lockfiles (`use_lockfile = true`) are used with compatible Terraform versions. The role needs access to the state object and lock object.

## Run Terraform

```bash
cd terraform
cp terraform.tfvars.example terraform.tfvars
cp backend.hcl.example backend.hcl
# Edit backend.hcl and replace the bucket name first.
terraform init -backend-config=backend.hcl
terraform fmt -recursive
terraform validate
terraform plan -out=tfplan
terraform apply tfplan
terraform output
aws eks update-kubeconfig --region "$(terraform output -raw aws_region)" --name "$(terraform output -raw cluster_name)"
kubectl get nodes
```

`enable_cluster_creator_admin_permissions = true` grants the IAM principal running Terraform cluster administrator access. For a team/production setup, explicitly configure EKS access entries for the deployment role and avoid relying on one operator identity.

The EKS API endpoint is publicly reachable in this demo. Restrict `cluster_endpoint_public_access_cidrs` to known office/VPN/runner egress IP ranges for production. GitHub-hosted runner IP ranges are broad and change; a self-hosted runner in the VPC is often preferable for a private-only endpoint.

## Destroy

```bash
terraform plan -destroy -out=destroy.tfplan
terraform apply destroy.tfplan
```

Empty/delete ECR images before destroying the repository if necessary. Do not delete the state bucket until you have confirmed the infrastructure is gone and state backups are no longer needed. NAT Gateways and EKS control planes incur charges while running.
