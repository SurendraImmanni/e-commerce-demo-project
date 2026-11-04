# CloudCart: A Node.js E-Commerce App on AWS EKS with a GitHub Actions DevSecOps Pipeline

A hands-on learning project. You will take a small Node.js e-commerce application and ship it to a Kubernetes cluster on AWS (Amazon EKS) using a fully automated CI/CD pipeline that scans the code and the container image for security problems, creates the infrastructure with Terraform, and rolls back automatically if a deployment goes wrong.

Nothing in this guide needs long-lived AWS access keys. GitHub proves its identity to AWS using **OIDC**, which is explained step by step in Section 9.

---

## Contents

1. [What you will build](#1-what-you-will-build)
2. [Prerequisites and cost](#2-prerequisites-and-cost)
3. [Repository layout](#3-repository-layout)
4. [The big picture: two workflows](#4-the-big-picture-two-workflows)
5. [The application code](#5-the-application-code)
6. [The Dockerfile explained](#6-the-dockerfile-explained)
7. [The Kubernetes manifests explained](#7-the-kubernetes-manifests-explained)
8. [The Terraform code explained](#8-the-terraform-code-explained)
9. [OIDC: connecting GitHub to AWS without access keys](#9-oidc-connecting-github-to-aws-without-access-keys)
10. [GitHub configuration: environments and variables](#10-github-configuration-environments-and-variables)
11. [The CI/CD pipeline code explained](#11-the-cicd-pipeline-code-explained)
12. [Step-by-step runbook](#12-step-by-step-runbook)
13. [Accessing the application](#13-accessing-the-application)
14. [Testing the rollback](#14-testing-the-rollback)
15. [Troubleshooting](#15-troubleshooting)
16. [Cleaning up](#16-cleaning-up)
17. [Security notes](#17-security-notes)
18. [Next steps and glossary](#18-next-steps-and-glossary)

---

## 1. What you will build

```
 Developer
    |  git push to main
    v
 GitHub repository
    |
    |  GitHub Actions
    |
    +--> Workflow 1: infrastructure.yml  (run first, rarely)
    |        Terraform --> VPC + ECR repository + EKS cluster + worker nodes
    |
    +--> Workflow 2: deploy.yml  (runs on every app change)
             Job 1  Test + SonarQube scan + quality gate
             Job 2  Docker build --> Trivy scan --> push to Amazon ECR
             Job 3  Deploy to EKS --> health check --> auto-rollback on failure

 GitHub  --(OIDC token)-->  AWS STS  --(temporary credentials)-->  AWS roles
```

The pipeline covers these steps:

| # | Requirement | Where it happens |
|---|---|---|
| 1 | Fetch the code from the repo | `actions/checkout` in every job |
| 2 | Install SonarQube and scan for vulnerabilities | `deploy.yml`, Job 1 |
| 3 | Create and build a Docker image | `deploy.yml`, Job 2 |
| 4 | Scan the image with Trivy | `deploy.yml`, Job 2 |
| 5 | Create the EKS cluster with Terraform | `infrastructure.yml` |
| 6 | Deploy the application to EKS | `deploy.yml`, Job 3 |
| 7 | Roll back if anything goes wrong | `deploy.yml` (automatic) and `rollback.yml` (manual) |

### Tools and what each one does

| Tool | Purpose |
|---|---|
| **GitHub Actions** | Runs the pipeline on GitHub's servers (called runners). |
| **SonarQube** | Static code analysis. Finds bugs, code smells and security hotspots in your source code. |
| **Docker** | Packages the app into a container image. |
| **Trivy** | Vulnerability scanner for container images (OS packages and npm libraries). |
| **Amazon ECR** | Private registry that stores your container images. |
| **Terraform** | Infrastructure as code. Creates the VPC, ECR repository and EKS cluster from `.tf` files. |
| **Amazon EKS** | Managed Kubernetes. Runs your containers. |
| **kubectl** | Command-line tool to talk to Kubernetes. |
| **OIDC** | Lets GitHub get short-lived AWS credentials without stored secrets. |

---

## 2. Prerequisites and cost

**Accounts**

- An AWS account with permission to create IAM roles, S3 buckets, VPCs, ECR and EKS.
- A GitHub account.

**Tools on your computer**

- Git
- AWS CLI v2 (`aws --version`), configured with `aws configure`
- kubectl
- Terraform 1.10 or newer (only needed to format code locally and for manual runs)
- Optional: Node.js 22 and Docker to run the app locally

**Cost warning.** The EKS control plane, the NAT gateway, the EC2 worker nodes and any load balancer all bill by the hour and are not fully covered by most free tiers. Do the clean-up in Section 16 as soon as you finish a session.

**Region.** The examples use `ap-south-1` (Mumbai). Use your own region consistently everywhere.

**Instance type note.** Some AWS accounts (for example, accounts on the Free Plan) only allow certain EC2 instance types. If node group creation fails because the instance type is not allowed, change `node_instance_types` in `terraform/variables.tf` to a type your account allows. This project was verified with `c7i-flex.large`.

---

## 3. Repository layout

```
.
├── app/                          Node.js application
│   ├── src/server.js             Express server and API routes
│   ├── src/products.js           Demo product data
│   ├── public/                   Front-end (HTML, CSS, JS, images)
│   ├── tests/app.test.js         Jest unit tests
│   ├── Dockerfile                Container build instructions
│   └── package.json / package-lock.json
├── kubernetes/
│   ├── namespace.yaml            Creates the "cloudcart" namespace
│   ├── configmap.yaml            Non-secret settings
│   ├── deployment.yaml           How the pods run (replicas, probes, security)
│   └── service.yaml              Stable network address for the pods
├── terraform/
│   ├── versions.tf               Terraform and provider versions, S3 backend
│   ├── variables.tf              Inputs (region, instance types, CIDRs)
│   ├── main.tf                   VPC, ECR repository, EKS cluster
│   ├── outputs.tf                Cluster name, ECR URL and so on
│   └── backend.hcl.example       Example remote-state settings
├── .github/workflows/
│   ├── infrastructure.yml        Terraform pipeline
│   ├── deploy.yml                Test, scan, build, push, deploy, auto-rollback
│   └── rollback.yml              Manual rollback
└── sonar-project.properties      SonarQube project settings
```

---

## 4. The big picture: two workflows

The infrastructure and the application are deployed by **separate workflows** because they have different lifecycles and need different permissions.

| | `infrastructure.yml` | `deploy.yml` |
|---|---|---|
| Purpose | Create or change AWS infrastructure | Ship a new version of the app |
| How often | Rarely | On every code change |
| Triggered by | Changes under `terraform/**`, or manually | Changes under `app/**`, `kubernetes/**`, or manually |
| AWS role | Terraform role (powerful) | Deploy role (small) |
| GitHub environment | `infrastructure` | `development` |

**Order matters.** The deploy workflow needs an ECR repository to push to and a cluster to deploy to. Both are created by Terraform. So you run the infrastructure workflow first and the deploy workflow after.

---

## 5. The application code

A small Express application that serves a product catalogue page and a few API endpoints.

| Endpoint | What it does |
|---|---|
| `GET /health` | Returns `{"status":"ok"}`. Used by Kubernetes probes and the pipeline health check. |
| `GET /api/products` | Lists products. |
| `GET /api/products/:id` | Returns one product, or 404. |
| `POST /api/checkout` | Demo checkout. Validates the cart and returns a total. No payment is taken. |

Two details worth noticing:

- The server only starts listening when run directly (`if (require.main === module)`). This lets the tests import the app without opening a port.
- A final error-handling middleware returns `400` for malformed JSON instead of a generic `500`.

Run the tests locally:

```bash
cd app
npm ci
npm run test:coverage
```

The pipeline runs the same command and feeds the coverage report to SonarQube.

---

## 6. The Dockerfile explained

```dockerfile
FROM node:22-alpine AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup
COPY --from=dependencies --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --chown=appuser:appgroup package*.json ./
COPY --chown=appuser:appgroup src ./src
COPY --chown=appuser:appgroup public ./public
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
USER appuser
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
```

| Part | Why it is there |
|---|---|
| Two stages (`dependencies`, `runtime`) | The final image contains only what the app needs to run. Build tooling stays behind. |
| `npm ci` with a lock file | Installs the exact versions in `package-lock.json`, so builds are repeatable. |
| `node:22-alpine` | A small base image, which means fewer packages and fewer vulnerabilities. |
| Non-root user `appuser` | If the app is compromised, the attacker does not get root inside the container. |
| `rm -rf ... npm ...` | The app starts with plain `node`, so npm is not needed at runtime. The npm tool that ships in the base image contains its own bundled libraries, and Trivy flagged known vulnerabilities in them. Removing npm removes those findings and shrinks the image. It must run **before** `USER appuser`. |
| `HEALTHCHECK` | Lets Docker detect a broken container. Kubernetes uses its own probes (Section 7). |

---

## 7. The Kubernetes manifests explained

**namespace.yaml** creates a namespace called `cloudcart` to keep the app's resources together.

**configmap.yaml** holds non-secret settings (`NODE_ENV`, `PORT`). Never put passwords in a ConfigMap.

**service.yaml** gives the pods a stable address:

```yaml
spec:
  type: ClusterIP          # reachable only inside the cluster
  selector:
    app.kubernetes.io/name: cloudcart
  ports:
    - name: http
      port: 80
      targetPort: http
```

**deployment.yaml** is the most important one. Key fields:

| Field | Meaning |
|---|---|
| `replicas: 2` | Two copies of the app run at all times. |
| `strategy: RollingUpdate`, `maxUnavailable: 0`, `maxSurge: 1` | During an update, Kubernetes starts one new pod first and only removes an old pod after the new one is ready. A bad version never takes the site down. |
| `progressDeadlineSeconds: 180` | If a rollout does not become healthy in 3 minutes, Kubernetes marks it as failed. The pipeline then triggers the rollback. |
| `revisionHistoryLimit: 5` | Keeps the last five versions so `kubectl rollout undo` has something to go back to. |
| `image: REPLACE_WITH_ECR_URI:REPLACE_WITH_IMAGE_TAG` | A placeholder. The pipeline replaces it with the real image address and the Git commit ID. |
| `startupProbe`, `readinessProbe`, `livenessProbe` | All call `/health`. Readiness decides whether a pod receives traffic. Liveness restarts a stuck pod. |
| `resources.requests / limits` | Reserves and caps CPU and memory so one pod cannot starve others. |
| `runAsNonRoot`, `readOnlyRootFilesystem`, `allowPrivilegeEscalation: false`, `capabilities: drop ALL` | Container hardening. The app runs with the fewest privileges possible. |
| `automountServiceAccountToken: false` | The pod does not receive Kubernetes API credentials it does not need. |

---

## 8. The Terraform code explained

Terraform reads `.tf` files and creates the resources they describe.

**versions.tf**

```hcl
terraform {
  required_version = ">= 1.10.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.80" }
  }
  backend "s3" {}
}
```

- `required_version >= 1.10.0` is needed because the remote-state locking feature `use_lockfile` was added in Terraform 1.10.
- `backend "s3" {}` stores the **state file** (Terraform's memory of what it created) in an S3 bucket so the pipeline and you share the same state. The bucket details are supplied at `terraform init` time through `backend.hcl`.

**variables.tf** defines inputs with defaults: region, project name, environment, Kubernetes version, network ranges, node instance types and node counts.

**main.tf** creates three things:

1. **VPC** (network), using the community module `terraform-aws-modules/vpc/aws`.
   - Two public and two private subnets across two availability zones.
   - A NAT gateway so private nodes can reach the internet to pull images. It is the most expensive part of the network.
   - Subnet tags `kubernetes.io/role/elb` and `kubernetes.io/role/internal-elb` tell Kubernetes where it may place load balancers.
2. **ECR repository** named `cloudcart-dev-app`.
   - `image_tag_mutability = "IMMUTABLE"`: a tag can never be overwritten. Each image is tagged with the Git commit ID, which gives a clean audit trail.
   - `scan_on_push = true` adds AWS's own scan on top of Trivy.
3. **EKS cluster** using `terraform-aws-modules/eks/aws`.
   - Worker nodes live in the private subnets.
   - `enable_cluster_creator_admin_permissions = true` makes whoever creates the cluster (here, the Terraform role) a cluster admin.
   - A managed node group with a configurable instance type and 2 to 3 nodes.
   - Add-ons: CoreDNS, kube-proxy, VPC CNI and the Pod Identity agent.

**outputs.tf** prints values you need later: cluster name, ECR URL and repository name.

Run Terraform by hand (optional):

```bash
cd terraform
cp backend.hcl.example backend.hcl      # then edit the bucket name and region
terraform fmt -recursive
terraform init -backend-config=backend.hcl
terraform plan -out=tfplan
terraform apply tfplan
```

---

## 9. OIDC: connecting GitHub to AWS without access keys

### 9.1 The problem OIDC solves

The old way to let a pipeline use AWS was to create an IAM user, generate an access key and store it as a GitHub secret. That key never expires, can leak, and has to be rotated by hand.

### 9.2 The idea

With **OIDC (OpenID Connect)**, GitHub acts as an identity provider. Think of a building with a security desk:

- GitHub's job is a visitor holding a **signed ID badge** that says who they are (which repo, which branch or environment).
- AWS is the **security desk**. It has been told in advance: "I trust badges signed by GitHub."
- An **IAM role** is a **room**, and its **trust policy** is the **guest list**: "only badges that say *this repo* and *this environment* may enter."
- If the badge matches the list, AWS hands out **temporary keys** (valid about an hour). When the job ends, they are worthless.

### 9.3 The flow

```
 1. Job starts and asks GitHub for an ID token   (needs: permissions: id-token: write)
 2. GitHub returns a signed JWT containing claims:
        iss = https://token.actions.githubusercontent.com
        aud = sts.amazonaws.com
        sub = "who is this?"   (repo + environment or branch)
 3. The job calls AWS STS AssumeRoleWithWebIdentity with the token and a role ARN
 4. AWS checks:  - is the signature from the trusted provider?
                 - does aud match?   - does sub match the role's trust policy?
 5. All match -> AWS returns temporary credentials -> Terraform / aws / kubectl use them
```

### 9.4 The three pieces you must create

| Piece | Where | What it does |
|---|---|---|
| **OIDC identity provider** | AWS IAM, once per account | Tells AWS to trust tokens from GitHub. |
| **IAM role with a trust policy** | AWS IAM, one per purpose | Says which GitHub jobs may use the role, and what the role may do. |
| **Workflow permission and action** | Your workflow file | Requests the token and exchanges it for credentials. |

### 9.5 Step-by-step setup

#### Step 1. Create the OIDC provider (once per AWS account)

Console: **IAM -> Identity providers -> Add provider**

- Provider type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`

CLI:

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com
```

You need only one provider per account, no matter how many roles you create. If it already exists, AWS will tell you.

#### Step 2. Understand the `sub` (subject) claim

The `sub` claim is what your trust policy matches against. It changes depending on how the job runs:

| Job type | `sub` looks like |
|---|---|
| Job **with** `environment: NAME` | `repo:OWNER/REPO:environment:NAME` |
| Job **without** an environment, on a branch | `repo:OWNER/REPO:ref:refs/heads/BRANCH` |
| Pull request | `repo:OWNER/REPO:pull_request` |

**Important gotcha.** As soon as a job declares `environment:`, its subject becomes the environment form. The branch form is **no longer sent** for that job. A trust policy that only lists `ref:refs/heads/main` will reject every job that uses an environment.

**Newer ID-based format.** Many repositories now send the numeric GitHub IDs inside the subject:

```
repo:OWNER@<OWNER_ID>/REPO@<REPO_ID>:environment:NAME
```

Matching is exact and case-sensitive, so you must use exactly the format GitHub sends to your repo. Do not guess: print it (next step).

#### Step 3. Discover your real subject

Add this temporary step to a workflow job **before** the credentials step (the job needs `permissions: id-token: write`):

```yaml
- name: Debug OIDC subject
  run: |
    TOKEN=$(curl -s -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)
    PAYLOAD=$(echo "$TOKEN" | cut -d. -f2 | tr '_-' '/+')
    while [ $((${#PAYLOAD} % 4)) -ne 0 ]; do PAYLOAD="${PAYLOAD}="; done
    echo "$PAYLOAD" | base64 -d | jq -r '.sub'
```

Run the workflow and read the line it prints. Copy that exact string into your trust policy. It is not a secret. Delete the step when everything works.

#### Step 4. Create the Terraform role

Console: **IAM -> Roles -> Create role -> Custom trust policy**. Name it `cloudcart-terraform-role`.

Trust policy (replace `<ACCOUNT_ID>` and the `sub` value with what your debug step printed):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": "repo:OWNER/REPO:environment:infrastructure"
        }
      }
    }
  ]
}
```

How to read it:

| Part | Meaning |
|---|---|
| `Principal.Federated` | The OIDC provider from Step 1. Only tokens from GitHub are considered. |
| `Action: sts:AssumeRoleWithWebIdentity` | The operation GitHub's token is allowed to perform. |
| `aud` condition | The token must be issued for AWS STS. |
| `sub` condition | The token must come from this repo and the `infrastructure` environment. This is the lock on the door. |

Permissions for this role: for a lab, attach the AWS managed policy `AdministratorAccess`. For production, replace it with a policy limited to VPC, EC2, EKS, IAM, ECR and the state bucket.

The role's ARN looks like `arn:aws:iam::<ACCOUNT_ID>:role/cloudcart-terraform-role`. Save it.

#### Step 5. Create the deploy role

Name it `cloudcart-deploy-role`. Its trust policy lists **two** subjects: one for the build job (no environment) and one for the deploy job (environment `development`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:OWNER/REPO:ref:refs/heads/main",
            "repo:OWNER/REPO:environment:development"
          ]
        }
      }
    }
  ]
}
```

Use your real subject format in both lines (confirm each with the debug step). Do not use a blanket wildcard such as `repo:OWNER/REPO:*`. It would let any branch, pull request or workflow in the repo use the role.

Permissions (an inline policy). This is all the pipeline needs:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
    {
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer", "ecr:DescribeRepositories"
      ],
      "Resource": "arn:aws:ecr:<REGION>:<ACCOUNT_ID>:repository/cloudcart-*"
    },
    { "Effect": "Allow", "Action": "eks:DescribeCluster", "Resource": "*" }
  ]
}
```

#### Step 6. Why two roles? (and can you use one?)

| | Terraform role | Deploy role |
|---|---|---|
| Used by | `infrastructure.yml` (rare) | `deploy.yml`, `rollback.yml` (every change) |
| Power | Near-admin | Push images and deploy only |
| Trusted subjects | `environment:infrastructure` | `main` branch and `environment:development` |

The deploy role runs far more often, and it runs code that includes your npm dependencies and third-party Actions. If those are ever compromised, an admin role would let the attacker delete your cluster and network. A small deploy role limits the damage. You can also require a different reviewer for each environment.

For a quick lab you **can** use a single role. Give it admin rights, list all three subjects in one trust policy, and set both role variables to the same ARN. Trade-off: anyone who can change `deploy.yml` on `main` effectively has admin access to the account.

#### Step 7. Allow GitHub to request tokens (workflow side)

```yaml
permissions:
  id-token: write      # lets the job request the OIDC token
  contents: read       # lets the job read the repo

steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
      aws-region: ${{ vars.AWS_REGION }}
```

Without `id-token: write`, the credentials step fails because no token can be requested.

#### Step 8. Give the deploy role access **inside** Kubernetes

IAM and Kubernetes are two separate permission systems. IAM decides who can call AWS APIs. Kubernetes decides who can run `kubectl` commands. The role that creates the cluster becomes its admin automatically. Any other role or user needs an **EKS access entry**.

Console: **EKS -> your cluster -> Access -> IAM access entries -> Create access entry**. Choose the principal, type **Standard**, attach `AmazonEKSClusterAdminPolicy` with scope **Cluster**.

CLI equivalent:

```bash
CLUSTER=cloudcart-dev-eks
ROLE=arn:aws:iam::<ACCOUNT_ID>:role/cloudcart-deploy-role
aws eks create-access-entry --cluster-name $CLUSTER --principal-arn $ROLE --region <REGION>
aws eks associate-access-policy --cluster-name $CLUSTER --principal-arn $ROLE --region <REGION> \
  --policy-arn arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy \
  --access-scope type=cluster
```

Cluster admin is used because the pipeline creates the namespace and lists nodes, both of which are cluster-wide. For production, create the namespace once yourself and use a narrower policy. Do the same for **your own IAM user** if you want to run `kubectl` from your laptop. An entry for a role does not cover a user.

### 9.6 Common OIDC errors

| Error | Cause | Fix |
|---|---|---|
| `Input required and not supplied: aws-region` | Workflow variables are empty. Often they were added to an environment, or to Secrets instead of Variables. | Add them as **repository variables** (Section 10). |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The role's trust policy does not match the token. | Print the real `sub` with the debug step and paste it exactly. Check the repo name spelling and capital letters, the environment name, and the ID-based format. |
| `Credentials could not be loaded` or no token | `permissions: id-token: write` is missing. | Add it at workflow or job level. |
| Syntax error when saving the trust policy | The editor still has old text, or a quote was changed to a curly quote when copying. | Clear the editor with Ctrl+A, Delete, then paste again. |
| `the server has asked for the client to provide credentials` (kubectl) | Your IAM identity has no EKS access entry. | Add an access entry for your user or role (Step 8). |

---

## 10. GitHub configuration: environments and variables

### Environments

**Settings -> Environments -> New environment.** Create two, with these exact lowercase names:

| Environment | Used by | Recommended setting |
|---|---|---|
| `infrastructure` | `infrastructure.yml` | Required reviewer (you), so Terraform apply waits for approval |
| `development` | `deploy-to-eks` job, `rollback.yml` | Optional reviewer |

If you are the only reviewer, leave **Prevent self-review** unticked, or nobody can approve your runs.

### Variables

**Settings -> Secrets and variables -> Actions -> Variables tab -> New repository variable.**

Add them as **repository** variables, not inside an environment. A job can only see environment variables if it declares that environment, and the build job declares none.

| Variable | Example | Where the value comes from |
|---|---|---|
| `AWS_REGION` | `ap-south-1` | Your chosen region |
| `AWS_TERRAFORM_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/cloudcart-terraform-role` | Step 4 |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/cloudcart-deploy-role` | Step 5 |
| `TF_STATE_BUCKET` | `my-tfstate-bucket` | The S3 bucket you create in the runbook |
| `TF_STATE_KEY` | `cloudcart/dev/terraform.tfstate` | The path of the state file inside the bucket |
| `ECR_REPOSITORY` | `cloudcart-dev-app` | **Name only**, from the Terraform output. Not the full URL. |
| `EKS_CLUSTER_NAME` | `cloudcart-dev-eks` | From the Terraform output |

**Common mistake.** `ECR_REPOSITORY` must be only the repository name. If you enter the full URL (`<ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/cloudcart-dev-app`) the pipeline adds the registry address a second time and the image name is wrong.

No SonarQube secrets are needed. The pipeline starts its own SonarQube and creates a token on the fly.

---

## 11. The CI/CD pipeline code explained

### 11.1 `infrastructure.yml` (Terraform)

```yaml
name: Provision AWS infrastructure

on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: ["terraform/**", ".github/workflows/infrastructure.yml"]

permissions:
  id-token: write
  contents: read

jobs:
  terraform:
    runs-on: ubuntu-latest
    environment: infrastructure
    defaults:
      run:
        working-directory: terraform
    steps:
      - uses: actions/checkout@v4
      - uses: hashicorp/setup-terraform@v3
        with: { terraform_version: "1.10.5" }
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_TERRAFORM_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - name: Prepare backend configuration
        run: |
          cat > backend.hcl <<EOF
          bucket       = "${{ vars.TF_STATE_BUCKET }}"
          key          = "${{ vars.TF_STATE_KEY }}"
          region       = "${{ vars.AWS_REGION }}"
          encrypt      = true
          use_lockfile = true
          EOF
      - run: terraform fmt -check -recursive
      - run: terraform init -backend-config=backend.hcl
      - run: terraform validate
      - run: terraform plan -input=false -out=tfplan -var="aws_region=${{ vars.AWS_REGION }}"
      - run: terraform apply -input=false -auto-approve tfplan
```

| Step | What it does |
|---|---|
| Triggers | Runs when Terraform files change, or manually from the Actions tab. |
| `environment: infrastructure` | Pauses for approval if you set reviewers. Also sets the OIDC subject the Terraform role must trust. |
| `setup-terraform` | Installs Terraform 1.10.5 on the runner. |
| `configure-aws-credentials` | The OIDC exchange. After this step, every command has temporary AWS credentials. |
| Prepare backend configuration | Writes the S3 state settings. `use_lockfile` stops two runs from changing the state at once. |
| `terraform fmt -check` | Fails if the code is not formatted. Fix locally with `terraform fmt -recursive`. |
| `init`, `validate` | Downloads providers and modules, then checks the syntax. |
| `plan -out=tfplan` | Shows what will change and saves it. |
| `apply tfplan` | Applies exactly the plan that was shown. Takes about 15 to 20 minutes the first time. |

### 11.2 `deploy.yml` (the main pipeline)

**Top of the file**

```yaml
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: ["app/**", "kubernetes/**", "sonar-project.properties", ".github/workflows/deploy.yml"]

permissions:
  id-token: write
  contents: read
  security-events: write

concurrency:
  group: cloudcart-deploy-${{ github.ref }}
  cancel-in-progress: false
```

- `paths` means the pipeline only starts when something relevant changes.
- `security-events: write` allows uploading the Trivy report to GitHub's Security tab.
- `concurrency` makes sure two deployments never run at the same time, and does not cancel one that is already running.

#### Job 1: `test-and-scan` (steps 1 and 2: fetch code, SonarQube)

```yaml
- uses: actions/checkout@v4
  with: { fetch-depth: 0 }
- uses: actions/setup-node@v4
  with: { node-version: "22", cache: npm, cache-dependency-path: app/package-lock.json }
- run: npm ci
  working-directory: app
- run: npm run test:coverage
  working-directory: app

- name: Install and start SonarQube
  run: |
    sudo sysctl -w vm.max_map_count=524288
    sudo sysctl -w fs.file-max=131072
    docker run -d --name sonarqube -p 9000:9000 sonarqube:community
```

What happens, in order:

1. **Checkout** fetches the repo. `fetch-depth: 0` gets full history, which SonarQube uses to find new code.
2. **Install dependencies and run tests** with coverage. The coverage report (`app/coverage/lcov.info`) is read by SonarQube.
3. **Install SonarQube.** The pipeline starts the official SonarQube Community container on the runner. The two `sysctl` lines raise kernel limits that SonarQube's built-in search engine needs.
4. **Wait, set password, create token.** A loop calls `/api/system/status` until the status is `UP`. The script then changes the default `admin/admin` password to a random one, generates a token, masks both values in the logs (`::add-mask::`) and stores the token in `GITHUB_ENV` for later steps.
5. **Scan.**

```yaml
- uses: SonarSource/sonarqube-scan-action@v5
  env:
    SONAR_TOKEN: ${{ env.SONAR_TOKEN }}
    SONAR_HOST_URL: ${{ env.SONAR_HOST_URL }}
  with:
    projectBaseDir: .
    args: >
      -Dsonar.qualitygate.wait=true
      -Dsonar.qualitygate.timeout=300
```

`qualitygate.wait=true` makes the step wait for SonarQube's verdict and **fail the pipeline if the quality gate fails**. The default gate checks things like security rating, duplication and coverage on new code.

6. **Export and upload findings.** The issue list is saved as the `sonarqube-report` artifact (`if: always()`, so you get it even when the gate fails).
7. **Stop SonarQube.** The container is thrown away.

*Trade-off:* this SonarQube is temporary, so there is no history or dashboard after the run. To keep a permanent server, host SonarQube yourself, store `SONAR_HOST_URL` (variable) and `SONAR_TOKEN` (secret), and delete the install and wait steps.

`sonar-project.properties` tells SonarQube what to scan:

```properties
sonar.projectKey=cloudcart-ecommerce
sonar.sources=app/src,app/public
sonar.tests=app/tests
sonar.exclusions=**/node_modules/**,**/coverage/**,**/*.svg
sonar.javascript.lcov.reportPaths=app/coverage/lcov.info
```

#### Job 2: `build-scan-push` (steps 3 and 4: Docker build, Trivy)

```yaml
needs: test-and-scan          # runs only if Job 1 passed
```

| Step | Explanation |
|---|---|
| Configure AWS credentials | OIDC with the **deploy role**. This job has no environment, so the token subject uses the branch form. |
| Resolve ECR repository | Builds the image name: `<account>.dkr.ecr.<region>.amazonaws.com/<ECR_REPOSITORY>:<git sha>`. Fails with a clear message if the variable is empty. |
| `amazon-ecr-login` | Lets Docker authenticate to ECR. |
| `docker build --pull` | Builds the image, always pulling the newest base image. |
| Trivy scan (gate) | Scans the built image and fails on fixable HIGH or CRITICAL findings. |
| Trivy SARIF report | A second scan that never fails, written in SARIF format for GitHub's Security tab. |
| `docker push` | Runs **only if** the scan passed, so a vulnerable image never reaches the registry. |

The Trivy step:

```yaml
- name: Scan image with Trivy (fail on HIGH/CRITICAL)
  uses: aquasecurity/trivy-action@57a97c7e7821a5776cebc9bb87c984fa69cba8f1 # v0.35.0
  with:
    image-ref: ${{ steps.ecr.outputs.image_uri }}
    format: table
    exit-code: "1"           # fail the job if findings match
    ignore-unfixed: true     # ignore issues with no patch available yet
    vuln-type: os,library    # OS packages and npm libraries
    severity: CRITICAL,HIGH
```

**Why a long hash instead of `@v0.35.0`?** A tag can be moved to different code after you start using it. Pinning to a full commit SHA locks the exact code you reviewed. This is not theoretical: in 2026 the Trivy Action and Trivy releases were the target of a supply-chain attack in which tags were repointed to malicious code (see CVE-2026-33634 and Aqua's advisory). Always pin security tools to a commit SHA and keep the version in a comment.

**Reading Trivy results.** The table lists each vulnerable package, its installed version, the fixed version and the severity. To fix a finding, upgrade the base image or the npm package. If you must accept a risk for a while, add the CVE ID to a `.trivyignore` file with a comment and an expiry date.

**Immutable tags.** Because ECR is set to `IMMUTABLE`, re-running the pipeline for the same commit cannot push the same tag twice. Push a new commit instead.

#### Job 3: `deploy-to-eks` (steps 6 and 7: deploy and rollback)

```yaml
needs: build-scan-push
environment: development       # approval gate, and the OIDC subject for the deploy role
```

**a) Connect and verify**

```yaml
- uses: azure/setup-kubectl@v4
  with: { version: "v1.33.0" }
- run: aws eks update-kubeconfig --region "${{ vars.AWS_REGION }}" --name "${{ vars.EKS_CLUSTER_NAME }}"
- run: |
    kubectl get nodes
    kubectl wait --for=condition=Ready nodes --all --timeout=10m
```

`update-kubeconfig` writes the cluster address and an AWS-based login method into the runner's kubeconfig. The deploy role must have its EKS access entry (Step 8), otherwise `kubectl` is rejected here.

**b) Remember what is running now (the rollback target)**

```yaml
- name: Record currently running revision (rollback target)
  id: current
  run: |
    REV="$(kubectl get deployment cloudcart -n cloudcart \
      -o jsonpath='{.metadata.annotations.deployment\.kubernetes\.io/revision}' 2>/dev/null || true)"
    echo "previous_revision=$REV" >> "$GITHUB_OUTPUT"
```

Kubernetes numbers every version of a Deployment (its "revision"). Before changing anything, the pipeline saves the current number as an output. On the very first deployment there is none, so it is empty.

**c) Deploy the new image**

```yaml
- name: Deploy new image
  id: deploy
  env:
    IMAGE_URI: ${{ needs.build-scan-push.outputs.image_uri }}
  run: |
    echo "started=true" >> "$GITHUB_OUTPUT"
    kubectl apply -f kubernetes/namespace.yaml
    kubectl apply -f kubernetes/configmap.yaml
    kubectl apply -f kubernetes/service.yaml
    sed "s|REPLACE_WITH_ECR_URI:REPLACE_WITH_IMAGE_TAG|${IMAGE_URI}|" \
      kubernetes/deployment.yaml > /tmp/deployment.rendered.yaml
    grep -q "$IMAGE_URI" /tmp/deployment.rendered.yaml
    kubectl apply -f /tmp/deployment.rendered.yaml
    kubectl rollout status deployment/cloudcart -n cloudcart --timeout=240s
```

- `started=true` marks that the pipeline has begun changing the cluster. The rollback step only runs after this point.
- `sed` swaps the placeholder in `deployment.yaml` for the real image, and `grep -q` double-checks that it worked.
- `kubectl rollout status` waits until the new pods are ready. If they never become ready, the command fails, which triggers the rollback.

**d) Health check from inside the cluster**

```yaml
- run: |
    kubectl run cloudcart-health-check-${{ github.run_id }} --rm -i --restart=Never \
      --image=curlimages/curl:8.12.1 -n cloudcart -- \
      curl --fail --retry 5 --retry-delay 2 http://cloudcart/health
```

A temporary pod calls the Service. This proves the app is reachable through Kubernetes networking, not only that the pods started.

**e) Automatic rollback**

```yaml
- name: Roll back on failure
  if: failure() && steps.deploy.outputs.started == 'true'
  run: |
    PREV="${{ steps.current.outputs.previous_revision }}"
    kubectl get pods -n cloudcart -o wide || true
    kubectl describe deployment cloudcart -n cloudcart | tail -40 || true
    kubectl logs deployment/cloudcart -n cloudcart --tail=50 || true

    if [ -n "$PREV" ]; then
      kubectl rollout undo deployment/cloudcart -n cloudcart --to-revision="$PREV"
      kubectl rollout status deployment/cloudcart -n cloudcart --timeout=300s
      echo "::error::Deployment failed and was rolled back to revision $PREV."
    else
      echo "::error::First deployment failed and there is no earlier revision."
      kubectl delete deployment cloudcart -n cloudcart --ignore-not-found
    fi
```

- `if: failure() && ... started == 'true'`: run only if an earlier step failed **and** the pipeline had already touched the cluster. A failure before that (for example, a login problem) does not trigger a rollback.
- It prints diagnostics (pods, events, logs) so you can see why it failed.
- `kubectl rollout undo --to-revision` returns to the exact version recorded earlier. It then waits for the old version to become healthy.
- The run still ends as **failed**, so the team notices, but the site stays up on the previous version.

Rollback has two layers of protection. Kubernetes itself keeps the old pods serving during a bad rollout (`maxUnavailable: 0` plus readiness probes), and the pipeline then undoes the failed revision.

### 11.3 `rollback.yml` (manual rollback)

Use this when a bad version passes every check and you notice later. In **Actions -> Manual rollback -> Run workflow**, leave `revision` empty to go back one version, or enter a revision number from the printed history.

```yaml
- run: kubectl rollout history deployment/cloudcart -n cloudcart
- run: |
    if [ -n "$REVISION" ]; then
      kubectl rollout undo deployment/cloudcart -n cloudcart --to-revision="$REVISION"
    else
      kubectl rollout undo deployment/cloudcart -n cloudcart
    fi
    kubectl rollout status deployment/cloudcart -n cloudcart --timeout=300s
```

The workflow validates that the revision is a number before using it, so it cannot be used to inject commands.

---

## 12. Step-by-step runbook

Follow these in order. Items in `<angle brackets>` are your own values.

### Phase 1. Create an empty GitHub repository

Create the repository on GitHub but **do not push code yet**. The workflows start on push, and would fail before the AWS side is ready.

### Phase 2. Prepare AWS (one time)

**2.1 Create the Terraform state bucket**

```bash
BUCKET=<globally-unique-bucket-name>
aws s3api create-bucket --bucket $BUCKET --region <REGION> \
  --create-bucket-configuration LocationConstraint=<REGION>
aws s3api put-bucket-versioning --bucket $BUCKET --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption --bucket $BUCKET --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
aws s3api put-public-access-block --bucket $BUCKET --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

(For `us-east-1`, omit the `--create-bucket-configuration` line.)

**2.2 Create the OIDC provider** (Section 9, Step 1).

**2.3 Create the two IAM roles** (Section 9, Steps 4 and 5). If you do not yet know your exact `sub` values, create the roles after the first debug run in Phase 4 and edit the trust policies.

### Phase 3. Configure GitHub

1. Create environments `infrastructure` and `development` (Section 10).
2. Add the repository variables `AWS_REGION`, `AWS_TERRAFORM_ROLE_ARN`, `AWS_DEPLOY_ROLE_ARN`, `TF_STATE_BUCKET`, `TF_STATE_KEY`. You will add `ECR_REPOSITORY` and `EKS_CLUSTER_NAME` after Terraform runs.

### Phase 4. Push the code and create the infrastructure

```bash
cd terraform && terraform fmt -recursive && cd ..       # the pipeline fails on unformatted files
git init -b main
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/<OWNER>/<REPO>.git
git push -u origin main
```

1. The push starts **Provision AWS infrastructure**. Open **Actions** and watch it.
2. If it fails at the credentials step with `Not authorized`, use the debug step, fix the trust policy, and re-run (Section 9).
3. Approve the `infrastructure` environment when asked. Terraform then builds the network, ECR and EKS (15 to 20 minutes).
4. The **Build, scan, push and deploy** workflow also starts on this first push and will fail because the AWS pieces are not ready. That is expected. Ignore it.

If a run is cancelled in the middle of `terraform apply`, a lock file may stay behind. See Section 15.

### Phase 5. Record the outputs

When the infrastructure run finishes, note the cluster name and ECR repository name (shown in the run summary), or run:

```bash
aws eks list-clusters --region <REGION>
aws ecr describe-repositories --region <REGION> --query 'repositories[].repositoryName'
```

Add repository variables `ECR_REPOSITORY` (name only) and `EKS_CLUSTER_NAME`.

### Phase 6. Give the deploy role Kubernetes access

Create the EKS access entry for `cloudcart-deploy-role` (Section 9, Step 8).

### Phase 7. Run the deployment pipeline

1. Go to **Actions -> Build, scan, push and deploy -> Run workflow**.
2. Watch the three jobs: SonarQube scan, then Docker build with the Trivy scan and push, then the EKS deploy. Approve the `development` environment if prompted.
3. Fix any failures using Section 15.

From now on, any push that changes `app/**` or `kubernetes/**` runs this pipeline automatically.

### Phase 8. Verify

```bash
aws eks update-kubeconfig --region <REGION> --name <cluster-name>
kubectl get nodes
kubectl get pods,svc -n cloudcart
```

You should see Ready nodes and two `Running` pods. Continue to Section 13 to open the app.

### Final checklist

- [ ] State bucket created
- [ ] OIDC provider created
- [ ] Two roles created with the correct trust policies and permissions
- [ ] Environments `infrastructure` and `development` created
- [ ] Seven repository variables set
- [ ] Infrastructure workflow succeeded
- [ ] EKS access entry created for the deploy role
- [ ] Deploy workflow succeeded and pods are `Running`

---

## 13. Accessing the application

The Service is `ClusterIP`, so it is only reachable from inside the cluster. There are two ways in.

### Option 1. Port-forward (quick, free, only you)

```bash
aws eks update-kubeconfig --region <REGION> --name <cluster-name>
kubectl port-forward -n cloudcart svc/cloudcart 8080:80
```

Open `http://localhost:8080`. Keep the terminal open while you use it. Useful URLs: `/health` and `/api/products`.

If `kubectl` says it needs credentials, your own IAM user has no EKS access entry. Add one (Section 9, Step 8) for your **user**, or for the role you log in with.

### Option 2. Public URL with a load balancer

Change `kubernetes/service.yaml`:

```yaml
spec:
  type: LoadBalancer
```

Commit and push. After the deploy finishes:

```bash
kubectl get svc cloudcart -n cloudcart
```

When the `EXTERNAL-IP` column shows an address ending in `.elb.amazonaws.com`, open `http://<that address>` (allow 2 to 3 minutes for DNS). This is plain HTTP, publicly reachable, and the load balancer costs money while it exists. Set the type back to `ClusterIP` to remove it.

---

## 14. Testing the rollback

1. In `app/src/server.js`, change the health route to fail:

```js
app.get("/health", (_req, res) => res.status(500).json({ status: "broken" }));
```

2. Commit and push. The code scan and the image scan will pass.
3. In the deploy job the new pods never become ready, so `kubectl rollout status` times out and the **Roll back on failure** step runs.
4. Check that the site still works on the old version:

```bash
kubectl rollout history deployment/cloudcart -n cloudcart
kubectl get pods -n cloudcart
```

5. Revert your change and push again.

Also try the manual path: **Actions -> Manual rollback -> Run workflow**.

---

## 15. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Input required and not supplied: aws-region` | Variables missing, in the wrong tab, or inside an environment. | Add them as repository variables (Section 10). |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | Trust policy `sub` does not match. | Use the debug step and copy the exact `sub`. Check repo name case, environment name and the ID-based format. |
| `Terraform exited with code 3` at the format step | Files are not formatted. | Run `terraform fmt -recursive`, commit and push. |
| `Error acquiring the state lock` (HTTP 412) | A cancelled run left a lock behind. | Make sure no run is active. Delete the `.tflock` file next to the state in S3, or run `terraform force-unlock <ID>`. Never delete the state file itself. |
| Node group creation fails because of the instance type | The type is not allowed for your account. | Change `node_instance_types` in `variables.tf` to an allowed type (for example `c7i-flex.large`). A failed node group is replaced on the next apply. |
| "Already exists" errors after a cancelled apply | Resources were created but not recorded in state. | Delete the leftovers in the console and re-run, or import them. |
| SonarQube never reaches `UP` | Slow start or low memory. | Check the container logs printed by the step. Startup can take 2 to 3 minutes. |
| Quality gate fails | Real findings or low coverage on new code. | Download the `sonarqube-report` artifact and fix the issues. |
| Trivy fails with HIGH or CRITICAL | A vulnerable package. | Upgrade the base image or the npm package shown in the report. For bundled npm findings, remove npm in the runtime image (Section 6). |
| Image name contains the registry address twice | `ECR_REPOSITORY` holds the full URL. | Set it to the repository name only. |
| ECR push fails with a tag-invalid error | The tag already exists and ECR is immutable. | Push a new commit. |
| `kubectl` says `Forbidden` or asks for credentials in the pipeline | The deploy role has no EKS access entry. | Create it (Section 9, Step 8). |
| `ImagePullBackOff` | Wrong repository name, or the image was never pushed. | Check `ECR_REPOSITORY` and the push step. |
| Pods not ready, rollout times out | The app is failing its health check. | `kubectl logs` and `kubectl describe pod` in the `cloudcart` namespace. The pipeline rolls back by itself. |

---

## 16. Cleaning up

Remove everything to stop charges.

1. If you created a load balancer, change the Service back to `ClusterIP` and redeploy, or run `kubectl delete svc cloudcart -n cloudcart`.
2. Delete the images in the ECR repository (`force_delete` is false, so Terraform cannot delete a non-empty repository).
3. Destroy the infrastructure:

```bash
cd terraform
cp backend.hcl.example backend.hcl        # fill in your bucket
terraform init -backend-config=backend.hcl
terraform destroy
```

4. Optionally delete the state bucket, the two IAM roles and the OIDC provider.

---

## 17. Security notes

- **No long-lived keys.** All AWS access uses OIDC and short-lived credentials.
- **Least privilege.** Two roles with different power. Trust policies list exact subjects, not wildcards.
- **Shift-left scanning.** SonarQube checks the code, and Trivy checks the image **before** it is pushed.
- **Immutable, traceable images.** Tags are Git commit IDs and cannot be overwritten.
- **Hardened containers.** Non-root user, read-only filesystem, no extra capabilities, no unused tooling in the image.
- **Supply chain.** Pin third-party Actions to full commit SHAs, as done for Trivy. Consider doing the same for the other Actions. Review updates before accepting them.
- **For production,** restrict the EKS public endpoint with `cluster_endpoint_public_access_cidrs`, replace `AdministratorAccess` and cluster-admin entries with narrower policies, enable HTTPS, and use branch protection with required reviews so nobody can change workflows without review.

---

## 18. Next steps and glossary

### Ideas to extend the project

- HTTPS and a custom domain with the AWS Load Balancer Controller, an Ingress and an ACM certificate
- Autoscaling: a Horizontal Pod Autoscaler and Karpenter or Cluster Autoscaler
- Secrets: AWS Secrets Manager with the External Secrets Operator
- Package the manifests as a Helm chart, or switch to GitOps with Argo CD
- A staging and a production environment with separate roles and approvals
- Monitoring and logging with Prometheus, Grafana and CloudWatch
- A permanent SonarQube server for history and dashboards

### Glossary

| Term | Meaning |
|---|---|
| **CI/CD** | Continuous Integration and Continuous Delivery. Automating build, test and deploy. |
| **Runner** | The temporary machine on which a GitHub Actions job runs. |
| **OIDC** | OpenID Connect. A standard that lets one service prove identity to another with signed tokens. |
| **STS** | AWS Security Token Service. Issues temporary credentials. |
| **Trust policy** | The IAM policy on a role that says who may assume it. |
| **Subject (`sub`)** | The claim in the OIDC token that identifies the repo and the environment or branch. |
| **Terraform state** | Terraform's record of the resources it manages. |
| **ECR** | Elastic Container Registry. AWS's private container image storage. |
| **EKS** | Elastic Kubernetes Service. AWS-managed Kubernetes. |
| **Pod** | The smallest unit in Kubernetes. One or more containers that run together. |
| **Deployment** | A Kubernetes object that keeps a set of identical pods running and manages updates. |
| **Service** | A stable network address in front of a set of pods. |
| **Namespace** | A named group of resources inside a cluster. |
| **Probe** | A health check Kubernetes runs against a container. |
| **Rollout / revision** | One version of a Deployment. Rolling back returns to an earlier revision. |
| **Access entry** | The EKS feature that maps an IAM user or role to Kubernetes permissions. |
| **Quality gate** | SonarQube's pass or fail rule for code quality and security. |
| **CVE** | A publicly numbered security vulnerability, for example CVE-2026-33634. |
| **SARIF** | A standard file format for security scan results. |
| **SHA pinning** | Referencing an Action by an exact commit hash instead of a movable tag. |

---

*This project is for learning. The checkout endpoint is a demo and takes no payments.*
