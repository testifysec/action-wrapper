# TestifySec Action Wrapper with Witness

A GitHub Action that downloads and executes another GitHub Action with Witness attestation.

## Usage

```yaml
name: Example Workflow
on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v3
      
      - name: Run Action with Witness Attestation
        id: attestation
        uses: testifysec/action-wrapper@v4
        with:
          # Action to run
          action-ref: "actions/hello-world-javascript-action@main"
          input-who-to-greet: "World"  # Passed to the nested action
          
          # Witness configuration
          step: "hello-world"
          attestations: "command attestor.git"
          enable-archivista: "true"
          archivista-server: "https://archivista.example.com"
```

## How It Works

This action combines the functionality of a GitHub Action wrapper with Witness attestation:

1. **Downloads Witness**: First, it downloads and installs the Witness tool
2. **Downloads the Action**: It fetches and extracts the specified GitHub Action
3. **Runs with Attestation**: The action is executed through Witness, which creates attestations
4. **Stores Results**: Attestations are stored (optionally in Archivista) and GitOIDs are returned

## Key Features

- **GitHub Action Execution**: Run any JavaScript GitHub Action
- **Witness Integration**: Create attestations for the action's execution
- **Archivista Support**: Store attestations in an Archivista server
- **Flexible Configuration**: Comprehensive options for Witness configuration
- **Attestor Support**: Run multiple attestors on the action's execution

## Inputs

### Action Reference

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `action-ref` | Reference to the nested action (e.g., owner/repo@ref) | Yes | |

### Witness Installation

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `witness-version` | Version of Witness to use | No | `0.2.11` |
| `witness-install-dir` | Directory to install Witness | No | `./` |

### Witness Core Options

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `step` | Step name for the attestation | Yes | |
| `attestations` | Space-separated list of attestors to run | Yes | |
| `outfile` | Path to output file for the attestation | No | |

### Archivista Configuration

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `enable-archivista` | Enable archivista for storing attestations | No | `false` |
| `archivista-server` | Archivista server URL | No | |

### Certificate & Signing Options

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `certificate` | Path to certificate file | No | |
| `key` | Path to key file | No | |
| `intermediates` | Space-separated list of intermediate certificate paths | No | |

### Sigstore Configuration

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `enable-sigstore` | Enable sigstore for signing | No | `false` |
| `fulcio` | Fulcio URL | No | |
| `fulcio-oidc-client-id` | Fulcio OIDC client ID | No | |
| `fulcio-oidc-issuer` | Fulcio OIDC issuer | No | |
| `fulcio-token` | Fulcio token | No | |

### Timestamp Configuration

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `timestamp-servers` | Space-separated list of timestamp server URLs | No | |

### Misc Options

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `trace` | Enable tracing | No | |
| `spiffe-socket` | Path to SPIFFE socket | No | |

### Product Configuration

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `product-exclude-glob` | Glob pattern for excluding products | No | |
| `product-include-glob` | Glob pattern for including products | No | |

### Attestor Export Options

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `attestor-link-export` | Export link attestor | No | `false` |
| `attestor-sbom-export` | Export SBOM attestor | No | `false` |
| `attestor-slsa-export` | Export SLSA attestor | No | `false` |
| `attestor-maven-pom-path` | Path to Maven POM file | No | |

### Action Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `input-*` | Any input with the prefix `input-` will be passed to the nested action | No | |
| `extra-args` | Extra arguments to pass to the nested action (deprecated, use `input-*` instead) | No | |

## Outputs

| Output | Description |
|--------|-------------|
| `git_oid` | GitOID of the attestation (if created) |

## Examples

### Basic Usage

```yaml
- name: Run with Witness
  id: witness-action
  uses: testifysec/action-wrapper@v4
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    input-who-to-greet: "World"
    step: "hello-world"
    attestations: "command"
```

### With Archivista

```yaml
- name: Run with Archivista
  id: archivista-action
  uses: testifysec/action-wrapper@v4
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    input-who-to-greet: "World"
    step: "hello-world-archivista"
    attestations: "command attestor.git"
    enable-archivista: "true"
    archivista-server: "https://archivista.example.com"

- name: Use GitOID
  run: echo "Generated attestation with ID ${{ steps.archivista-action.outputs.git_oid }}"
```

### Multiple Attestors

```yaml
- name: Run with Multiple Attestors
  uses: testifysec/action-wrapper@v4
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    input-who-to-greet: "World"
    step: "hello-world-attestors"
    attestations: "command attestor.git attestor.slsa attestor.sbom"
    attestor-slsa-export: "true"
    attestor-sbom-export: "true"
    outfile: "./attestation.json"
```