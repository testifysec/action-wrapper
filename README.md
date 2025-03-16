# TestifySec Action Wrapper

A GitHub Action that downloads and executes another GitHub Action dynamically.

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
        uses: testifysec/action-wrapper@v1
        with:
          action-ref: "owner/repo@v1.0.0"
          extra-args: "--foo bar"
```

## Inputs

| Input | Description | Required |
|-------|-------------|----------|
| `action-ref` | Reference to the nested action (e.g., owner/repo@ref) | Yes |
| `extra-args` | Extra arguments to pass to the nested action | No |

## How It Works

1. **Parsing the Input:**  
   The wrapper reads an input `action-ref` (like `"owner/repo@ref"`) and splits it into the repository identifier and ref.

2. **Downloading the Repository:**  
   It constructs the URL for the GitHub zip archive and downloads it using Axios. The zip is then extracted using the `unzipper` package into a temporary directory.

3. **Reading Action Metadata:**  
   The script reads the `action.yml` file from the extracted folder to determine the JavaScript entry point (from the `runs.main` field).

4. **Dependency Installation (Optional):**  
   If a `package.json` is present in the nested action, it runs `npm install` to install dependencies.

5. **Executing the Nested Action:**  
   Finally, the wrapper runs the nested action's entry file using Node.js. Any extra arguments provided via the `extra-args` input are passed along.
