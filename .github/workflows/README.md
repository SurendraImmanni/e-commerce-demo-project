# GitHub Actions setup

Two workflows are intentionally used because ECR must exist before an image can be pushed, and EKS must exist before deployment.

1. Run **Provision AWS infrastructure** once after configuring the Terraform backend and GitHub variables.
2. Run **Build, scan, push and deploy** for application changes.

## Required repository variables

Configure these under **Settings → Secrets and variables → Actions → Variables**:

- `AWS_REGION`: e.g. `ap-south-1`
- `AWS_TERRAFORM_ROLE_ARN`: IAM role ARN allowed to provision infrastructure
- `AWS_DEPLOY_ROLE_ARN`: IAM role ARN used for ECR push and EKS deployment
- `TF_STATE_BUCKET`: pre-created private S3 bucket
- `TF_STATE_KEY`: e.g. `cloudcart/dev/terraform.tfstate`
- `ECR_REPOSITORY`: exact repository name from Terraform output, e.g. `cloudcart-dev-app`
- `EKS_CLUSTER_NAME`: exact cluster name from Terraform output, e.g. `cloudcart-dev-eks`
- Optional `ENVIRONMENT`: `dev`
- Optional `TF_WORKSPACE_KEY`: `dev`

No SonarQube secrets are needed: the pipeline starts its own SonarQube container and creates a token per run.

## SonarQube

The pipeline installs SonarQube as a container on the runner. To use a permanent server instead, add `SONAR_HOST_URL` (variable) and `SONAR_TOKEN` (secret) and remove the install/wait steps from `deploy.yml`.

## Environments

Create GitHub environments `infrastructure` and `development`. Add required reviewers to both so Terraform applies and deployments need approval.

## IAM and OIDC

Create the AWS IAM GitHub OIDC provider if absent:
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

Use separate roles for Terraform and deployment where possible. Trust policy example (replace OWNER, REPO, and branch; the `sub` condition is intentionally branch-scoped):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringEquals": {
        "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
        "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:ref:refs/heads/main"
      }
    }
  }]
}
```

The deployment role needs scoped ECR permissions (`ecr:GetAuthorizationToken`, and repository-scoped `ecr:BatchCheckLayerAvailability`, `ecr:InitiateLayerUpload`, `ecr:UploadLayerPart`, `ecr:CompleteLayerUpload`, `ecr:PutImage`, `ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`) plus EKS cluster describe permissions. It also needs an EKS access entry granting the role Kubernetes permissions to deploy in the `cloudcart` namespace, or an equivalent access configuration. IAM `eks:DescribeCluster` alone does not grant Kubernetes API permissions.

The Terraform role needs permissions to manage the resources in `terraform/main.tf` and access to the S3 state object/lock file. This is a broad infrastructure role by nature; scope it to your account and intended resources, and consider a reviewed plan/approval for production. Do not attach AdministratorAccess as a permanent shortcut.

Important: The Terraform configuration enables cluster-creator admin permissions for the principal that runs Terraform. For GitHub-based deployment, add an EKS access entry for the deployment role after cluster creation and associate a suitable access policy, or extend the Terraform module with a tightly scoped access entry. This sample README calls out that extra step because IAM and Kubernetes RBAC are separate layers.
