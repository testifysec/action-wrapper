# TestifySec Action Wrapper

A GitHub Action that downloads and executes another GitHub Action dynamically with optional strace instrumentation.

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
      - name: Run Nested Action via Wrapper
        uses: testifysec/action-wrapper@v2
        with:
          action-ref: "actions/hello-world-javascript-action@main"
          input-who-to-greet: "World"  # Passed to the nested action as who-to-greet
          enable-strace: "true"  # Enable strace instrumentation
```

## Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `action-ref` | Reference to the nested action (e.g., owner/repo@ref) | Yes | |
| `enable-strace` | Enable strace instrumentation | No | `true` |
| `strace-options` | Options to pass to strace | No | `-f -e trace=network,write,open` |
| `input-*` | Any input with the prefix `input-` will be passed to the nested action | No | |
| `extra-args` | Extra arguments to pass to the nested action (deprecated, use `input-*` instead) | No | |

### Passing Inputs to Nested Actions

To pass inputs to the nested action, prefix them with `input-`. For example:

- `input-who-to-greet: "World"` will be passed to the nested action as `who-to-greet: "World"`
- `input-token: ${{ secrets.GITHUB_TOKEN }}` will be passed as `token: ${{ secrets.GITHUB_TOKEN }}`

## Outputs

| Output | Description |
|--------|-------------|
| `strace-log` | Path to the strace output log file (if strace was enabled and successful) |

## Features

- **Flexible Reference Handling**: Supports both tags (e.g., `v1.0.0`) and branch names (e.g., `main`)
- **Smart Extraction**: Intelligently finds the extracted directory even if naming patterns change
- **Format Flexibility**: Supports both `action.yml` and `action.yaml` metadata files
- **Robust Error Handling**: Attempts alternative download URLs if the first one fails
- **Dependency Management**: Automatically installs dependencies for the wrapped action
- **Strace Integration**: Optionally traces system calls made by the wrapped action

## How It Works

1. **Parsing the Input:**  
   The wrapper reads an input `action-ref` (like `"owner/repo@ref"`) and splits it into the repository identifier and ref.

2. **Downloading the Repository:**  
   It constructs the URL for the GitHub zip archive, automatically handling both branch and tag references. The zip is then downloaded using Axios and extracted using the `unzipper` package into a temporary directory.

3. **Reading Action Metadata:**  
   The script reads the action's metadata file (either `action.yml` or `action.yaml`) from the extracted folder to determine the JavaScript entry point (from the `runs.main` field).

4. **Dependency Installation (Optional):**  
   If a `package.json` is present in the nested action, it runs `npm install` to install dependencies.

5. **Strace Instrumentation (Optional):**  
   If strace is enabled and available, the action runs the nested action with strace to trace system calls.

6. **Executing the Nested Action:**  
   Finally, the wrapper runs the nested action's entry file using Node.js. Any extra arguments provided via the `extra-args` input are passed along.

## Examples

### Using with a Tagged Release

```yaml
- name: Run Release Version
  uses: testifysec/action-wrapper@v1
  with:
    action-ref: "actions/hello-world-javascript-action@v1.1.0"
```

### Using with a Branch

```yaml
- name: Run Latest Version
  uses: testifysec/action-wrapper@v1
  with:
    action-ref: "actions/hello-world-javascript-action@main"
```

### Passing Inputs to the Nested Action

```yaml
- name: Run with Inputs
  uses: testifysec/action-wrapper@v2
  with:
    action-ref: "some/action@v1"
    input-username: "octocat"
    input-token: ${{ secrets.GITHUB_TOKEN }}
    input-repository: ${{ github.repository }}
```

### Using with Strace

```yaml
- name: Run with Strace
  id: strace-action
  uses: testifysec/action-wrapper@v2
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    enable-strace: "true"
    strace-options: "-f -e trace=network,write,open,close -o /tmp/trace.log"
    input-who-to-greet: "World"  # Passed to the nested action as who-to-greet

- name: Upload Strace Results
  uses: actions/upload-artifact@v4
  with:
    name: strace-logs
    path: ${{ steps.strace-action.outputs.strace-log }}
```

### Disabling Strace

```yaml
- name: Run Without Strace
  uses: testifysec/action-wrapper@v2
  with:
    action-ref: "actions/hello-world-javascript-action@main"
    enable-strace: "false"
    input-who-to-greet: "World"  # Passed to the nested action as who-to-greet
```
